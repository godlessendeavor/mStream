// This is designed to run as it's own process
// It takes in a json array
//  {
//    "vpath":"metal",
//    "directory":"/path/to/metal/music",
//    "dbPath":"/path/to/LATEST-GREATEST.DB",
//    "pause": 500,
//    "saveInterval": 1000,
//    "skipImg":true
//    "albumArtDirectory": "/album/art/dir"
// }

// Parse input JSON
try {
  var loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// TODO: Validate input

// Libraries
const metadata = require('music-metadata');
const fs = require('fs');
const fe = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const util = require('util');

// Only parse these file types
const fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus"];

// Setup DB layer
// The DB functions are decoupled from this so they can easily be swapped out
const dbRead = require('../db-write/database-default-loki.js');

// Global Vars
const globalCurrentFileList = {};  // Map of file paths to songs
const listOfFilesToParse = [];
const listOfFilesToDelete = [];
const listOfSongsToUpdate = [];
const mapOfDirectoryAlbumArt = {};

// Start the generator
const parseFilesGenerator = scanDirectory(loadJson.directory);
parseFilesGenerator.next();

// Scan the directory for new, modified, and deleted files
function* scanDirectory(directoryToScan) {
  yield dbRead.setup(loadJson.dbPath, loadJson.saveInterval, (err) => {
    if (err) {
      console.error(`Warning: failed to load database`);
      process.exit(1);
    }
    parseFilesGenerator.next();
  });

  // Pull filelist from DB
  pullFromDB();
  // Loop through current files and compare them to the files pulled from the DB
  recursiveScan(directoryToScan);
  
  dbRead.updateEntries(listOfSongsToUpdate);

  // Delete Files
  for (var i = 0; i < listOfFilesToDelete.length; i++) {
    deleteFile(listOfFilesToDelete[i]);
  }
  // Delete all remaining files
  for (var file in globalCurrentFileList) {
    deleteFile(fe.join(loadJson.directory, file));
  }
  // Parse and add files to DB
  for (var i = 0; i < listOfFilesToParse.length; i++) {
    yield parseFile(fe.join(loadJson.directory, listOfFilesToParse[i]));
  }

  yield dbRead.savedb(() => {
    parseFilesGenerator.next();
  });

  // Exit
  process.exit(0);
}

// Get all files from DB and add to globalCurrentFileList
function pullFromDB() {
  dbRead.getVPathFiles(loadJson.vpath, function (rows) {
    for (var song of rows) {
      globalCurrentFileList[song.filepath] = song;
    }
  });
}

function recursiveScan(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return;
  }

  var aaFile = checkDirectoryForAlbumArt(dir);

  // loop through files
  for (var i = 0; i < files.length; i++) {
    const filepath = fe.join(dir, files[i]);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      recursiveScan(filepath);
    } else {
      // Make sure this is in our list of allowed files
      if (fileTypesArray.indexOf(getFileType(files[i]).toLowerCase()) === -1) {
        continue;
      }

      // Check if in globalCurrentFileList
      if (!(fe.relative(loadJson.directory, filepath) in globalCurrentFileList)) {
        // if not parse new file, add it to DB, and continue
        listOfFilesToParse.push(fe.relative(loadJson.directory, filepath)); // use relative to remove extra data
        continue;
      }

      // check if the album art has changed
      if (aaFile !== undefined && aaFile !== false && aaFile !== globalCurrentFileList[fe.relative(loadJson.directory, filepath)].aaFile){
        console.log(`New cover file ${aaFile} is being added to the DB`);
        globalCurrentFileList[fe.relative(loadJson.directory, filepath)].aaFile = aaFile;
        listOfSongsToUpdate.push(globalCurrentFileList[fe.relative(loadJson.directory, filepath)]);
      }

      // check the file_modified_date
      if (stat.mtime.getTime() !== globalCurrentFileList[fe.relative(loadJson.directory, filepath)].modified) {
        listOfFilesToParse.push(fe.relative(loadJson.directory, filepath));
        listOfFilesToDelete.push(filepath);
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[filepath];
    }
  }
}

function parseFile(thisSong) {
  var fileStat = fs.statSync(thisSong);
  if (!fileStat.isFile()) {
    console.error(`Warning: failed to parse file ${thisSong}: Unknown Error`);
    parseFilesGenerator.next();
    return;
  }

  const opt = {};
  if(loadJson.skipImg) {
    opt.skipCovers = true;
  }

  // Parse the file for metadata and store it in the DB
  return metadata.parseFile(thisSong, opt).then(thisMetadata => {
    return thisMetadata.common;
  }).catch(err => {
    console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
    return {track: { no: null, of: null }, disk: { no: null, of: null }};
  }).then(songInfo => {
    //console.info(`Calculating the hash for ${thisSong}`);
    songInfo.modified = fileStat.mtime.getTime();
    songInfo.filePath = fe.relative(loadJson.directory, thisSong);
    songInfo.format = getFileType(thisSong);
    // Calculate unique DB ID
    return calculateHash(thisSong, songInfo);
  }).then(songInfo => {
    // Stores metadata of song in the database
    return dbRead.insertEntries([songInfo], loadJson.vpath)
  }).then(() => {
    // Continue with next file
    if(loadJson.pause && loadJson.pause > 0) {
      setTimeout(() => { parseFilesGenerator.next(); }, loadJson.pause);
    } else {
      parseFilesGenerator.next();
    }
  }).catch(err => {
    console.error(`Warning: failed to add file ${thisSong} to database: ${err.message}`);
    if(loadJson.pause && loadJson.pause > 0) {
      setTimeout(() => { parseFilesGenerator.next(); }, loadJson.pause);
    } else {
      parseFilesGenerator.next();
    }
  });
}

function calculateHash(thisSong, songInfo) {
  return new Promise((resolve, reject) => {
    // Handle album art
    var albumArt = checkDirectoryForAlbumArt(fe.dirname(thisSong));
    if (albumArt) {
      songInfo.aaFile = albumArt;
    }

    // Hash the file here and add the hash to the DB
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', () => {
      hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      resolve(songInfo);
    });

    readableStream2.pipe(hash);
  });
}

function checkDirectoryForAlbumArt(directory) {
 
  if (loadJson.skipImg === true) {
    return false;
  }
 
  var files = fs.readdirSync(directory);
  var imageArray = [];

  // loop through files
  for (var i = 0; i < files.length; i++) {
    var filepath = fe.join(directory, files[i]);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      continue;
    }

    // Make sure its jpg/png
    if (["png", "jpg", "PNG", "JPG"].indexOf(getFileType(files[i])) === -1) {
      continue;
    }

    imageArray.push(files[i]);
  }


  if (imageArray.length === 0) {
    mapOfDirectoryAlbumArt[directory] = false;
    return false;
  }

  var aaFile = false;

  // Only one image, assume it's album art
  if (imageArray.length === 1) {
    aaFile = fe.join(directory, imageArray[0]);
    aaFile = fe.relative(loadJson.directory, aaFile);
  }else {
    // If there are multiple images, choose the first one with name front
    for (var i = 0; i < imageArray.length; i++) {
      const imgMod = imageArray[i].toLowerCase();
      if (imgMod.includes('front')) {
        aaFile = fe.join(directory, imageArray[i]);
        aaFile = fe.relative(loadJson.directory, aaFile);
        break;
      }
    }
  }

  //If none match, choose the first image
  if (!aaFile) {
      aaFile = fe.join(directory, imageArray[0]);
      aaFile = fe.relative(loadJson.directory, aaFile);
  }

  mapOfDirectoryAlbumArt[directory] = aaFile;
  return aaFile;
}

function deleteFile(filepath) {
  dbRead.deleteFile(filepath, function () { });
}

function getFileType(filename) {
  return filename.split(".").pop();
}
