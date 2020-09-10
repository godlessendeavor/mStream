const fe = require('path');
const loki = require('lokijs');
const winston = require('winston');
const sync = require('../sync');
const util = require('util');
const fs = require('fs');

const userDataDbName = 'user-data.loki-v1.db'

// Loki Collections
var filesDB;
var userDataDb;

var fileCollection;
var playlistCollection;
var userMetadataCollection;

// Default Functions for joining
const mapFunDefault = function(left, right) {
  return {
    artist: left.artist,
    album: left.album,
    hash: left.hash,
    track: left.track,
    title: left.title,
    year: left.year,
    'album-art': left.aaFile,
    filepath: left.filepath,
    rating: right.rating,
    vpath: left.vpath
  };
};

const rightFunDefault = function(rightData) {
  return rightData.hash + '-' + rightData.user;
};

function loadDB() {
  filesDB.loadDatabase({}, err => {
    if (err) {
      winston.error(`Files DB Load Error : ${err}`);
      return;
    }

    // Get files collection
    fileCollection = filesDB.getCollection('files');
  });

  userDataDb.loadDatabase({}, err => {
    if (err) {
      winston.error(`Playlists DB Load Error : ${err}`);
      return;
    }

    // Initialize playlists collection
    playlistCollection = userDataDb.getCollection('playlists');
    if (!playlistCollection) {
      // first time run so add and configure collection with some arbitrary options
      playlistCollection = userDataDb.addCollection("playlists");
    }

    // Initialize user metadata collection (for song ratings, playback stats, etc)
    userMetadataCollection = userDataDb.getCollection('user-metadata');
    if (!userMetadataCollection) {
      userMetadataCollection = userDataDb.addCollection("user-metadata");
    }
  });
}

exports.loadDB = function () {
  loadDB();
}

exports.getNumberOfFiles = function (vpaths, callback) {
  if (!fileCollection) {
    callback(0);
    return;
  }

  let total = 0;
  for (let vpath of vpaths) {
    total += fileCollection.count({ 'vpath': vpath })
  }

  callback(total);
}

exports.setup = function (mstream, program) {
  filesDB = new loki(fe.join(program.storage.dbDirectory, program.filesDbName));
  userDataDb = new loki(fe.join(program.storage.dbDirectory, userDataDbName));

  // Used to determine the user has a working login token
  mstream.get('/ping', (req, res) => {
    let transcode = false;
    if (program.transcode && program.transcode.enabled) {
      transcode = {
        defaultCodec: program.transcode.defaultCodec,
        defaultBitrate: program.transcode.defaultBitrate,
      }
    }

    res.json({
      vpaths: req.user.vpaths,
      playlists: getPlaylists(req.user.username),
      federationId: sync.getId(),
      transcode
    });
  });

  // Metadata lookup
  mstream.post('/db/metadata', (req, res) => {
    const pathInfo = program.getVPathInfo(req.body.filepath, req.user);
    if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }

    if (!fileCollection) {
      res.json({ "filepath": req.body.filepath, "metadata": {} });
      return;
    }
    
    const leftFun = function(leftData) {
      return leftData.hash + '-' + req.user.username;
    };

    const result = fileCollection.chain().find({ '$and': [{'filepath': pathInfo.relativePath}, {'vpath': pathInfo.vpath}] }, true)
      .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault).data();

    if (!result || !result[0]) {
      res.json({ "filepath": req.body.filepath, "metadata": {} });
      return;
    }

    res.json({
      "filepath": req.body.filepath,
      "metadata": {
        "artist": result[0].artist ? result[0].artist : null,
        "hash": result[0].hash ? result[0].hash : null,
        "album": result[0].album ? result[0].album : null,
        "track": result[0].track ? result[0].track : null,
        "title": result[0].title ? result[0].title : null,
        "year": result[0].year ? result[0].year : null,
        "album-art": result[0]['album-art'] ? result[0]['album-art']: null,
        "rating": result[0].rating ? result[0].rating : null
      }
    });
  });

  mstream.post('/playlist/add-song', (req, res) => {
    if(!req.body.song || !req.body.playlist) {
      return res.status(500).json({ error: 'Missing Params' });
    }

    if(!playlistCollection) {
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    playlistCollection.insert({
      name: req.body.playlist,
      filepath: req.body.song,
      user: req.user.username
    });

    res.json({ success: true });
    userDataDb.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  mstream.post('/playlist/remove-song', (req, res) => {
    if (!req.body.lokiid){
      return res.status(500).json({ error: 'Missing Params' });
    }

    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    playlistCollection.findAndRemove({ '$loki': req.body.lokiid });
    res.json({ success: true });
    userDataDb.saveDatabase(err => {
      if (err) {
        winston.error(`BB Save Error : ${err}`)
      }
  });
 });

  // Save playlists
  mstream.post('/playlist/save', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    const title = req.body.title;
    const songs = req.body.songs;

    // Delete existing playlist
    playlistCollection.findAndRemove({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': title }
      }]
    });


    while (songs.length > 0) {
      const song = songs.shift();
      playlistCollection.insert({
        name: title,
        filepath: song,
        user: req.user.username
      });
    }

    res.json({ success: true });
    userDataDb.saveDatabase(err =>  {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  // Get all playlists
  mstream.get('/playlist/getall', (req, res) => {
    res.json(getPlaylists(req.user.username));
  });

  function getPlaylists(username) {
    const playlists = [];

    const results = playlistCollection.find({ 'user': { '$eq': username } });
    const store = {};
    for (let row of results) {
      if (!store[row.name]) {
        playlists.push({ name: row.name });
        store[row.name] = true;
      }
    }
    return playlists;
  } 

  // Load a playlist
  mstream.post('/playlist/load', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    const playlist = String(req.body.playlistname);
    const returnThis = [];

    const results = playlistCollection.find({
      '$and': [{
        'user': { '$eq': req.user.username }
      }, {
        'name': { '$eq': playlist }
      }]
    });

    for (let row of results) {
      // Look up metadata
      const pathInfo = program.getVPathInfo(row.filepath, req.user);
      if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }

      let metadata = {};

      if (fileCollection) {
        const leftFun = function(leftData) {
          return leftData.hash + '-' + req.user.username;
        };
        
        const result = fileCollection.chain().find({ '$and': [{'filepath': pathInfo.relativePath}, { 'vpath': pathInfo.vpath }] }, true)
          .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault).data();

        if (result && result[0]) {
          metadata = {
            "artist": result[0].artist ? result[0].artist : null,
            "hash": result[0].hash ? result[0].hash : null,
            "album": result[0].album ? result[0].album : null,
            "track": result[0].track ? result[0].track : null,
            "title": result[0].title ? result[0].title : null,
            "year": result[0].year ? result[0].year : null,
            "album-art": result[0].aaFile ? result[0].aaFile : null,
            "rating": result[0].rating ? result[0].rating : null
          };
        }
      }

      returnThis.push({ lokiId: row['$loki'], filepath: row.filepath, metadata: metadata });
    }

    res.json(returnThis);
  });

  // Delete playlist
  mstream.post('/playlist/delete', (req, res) => {
    if (!playlistCollection){
      return res.status(500).json({ error: 'Playlist DB Not Initiated' });
    }

    // Delete existing playlist
    playlistCollection.findAndRemove({
      '$and': [
        { 'user': { '$eq': req.user.username }},
        { 'name': { '$eq': req.body.playlistname }}
      ]
    });

    res.json({ success: true });
    userDataDb.saveDatabase(err =>  {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  mstream.get('/db/artists', (req, res) => {
    const artists = { "artists": [] };
    if (!fileCollection) { res.json(artists); }
  
    let orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    const results = fileCollection.find(orClause);
    const store = {};
    for (let row of results) {
      if (!store[row.artist] && !(row.artist === undefined || row.artist === null)) {
        store[row.artist] = true;
      }
    }

    artists.artists = Object.keys(store).sort((a, b) => {
      return a.localeCompare(b);
    });

    res.json(artists);
  });

  mstream.post('/db/artists-albums', (req, res) => {
    const albums = { "albums": [] };
    if (fileCollection) {
      let orClause;
      if (req.user.vpaths.length === 1) {
        orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
      } else {
        orClause = { '$or': [] }
        for (let vpath of req.user.vpaths) {
          orClause['$or'].push({ 'vpath': { '$eq': vpath } })
        }
      }

      const results = fileCollection.chain().find({
        '$and': [
          orClause, 
          {'artist': { '$eq': String(req.body.artist) }}
        ]
      }).simplesort('year', true).data();

      const store = {};
      for (let row of results) {
        if (!store[row.album]) {
          albums.albums.push({
            name: row.album,
            album_art_file: row.aaFile ? row.aaFile : null
          });
          store[row.album] = true;
        }
      }
    }
    res.json(albums);
  });

  mstream.get('/db/albums', (req, res) => {
    const albums = { "albums": [] };
    if (!fileCollection) { return res.json(albums); }
  
    let orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    const results = fileCollection.find(orClause);
    const store = {};
    for (let row of results) {
      if (!store[row.album] && !(row.album === undefined || row.album === null)) {
        albums.albums.push({ name: row.album, album_art_file: row.aaFile });
        store[row.album] = true;
      }
    }

    albums.albums.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

    res.json(albums);
  });

  mstream.post('/db/album-songs', (req, res) => {
    const songs = [];
    if (fileCollection) {
      let orClause;
      if (req.user.vpaths.length === 1) {
        orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
      } else {
        orClause = { '$or': [] }
        for (let vpath of req.user.vpaths) {
          orClause['$or'].push({ 'vpath': { '$eq': vpath } })
        }
      }

      let artistClause;
      if (req.body.artist) {
        artistClause = {'artist': { '$eq':  String(req.body.artist) }}
      }

      const leftFun = function(leftData) {
        return leftData.hash + '-' + req.user.username;
      };
  
      const album = req.body.album ? String(req.body.album) : null;
      const results = fileCollection.chain().find({
        '$and': [
          orClause,
          {'album': { '$eq': album }},
          artistClause
        ]
      }).compoundsort(['disk','track','filepath']).eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault).data();

      for (let row of results) {
        songs.push({
          "filepath": fe.join(row.vpath, row.filepath).replace(/\\/g, '/'),
          "metadata": {
            "artist": row.artist ? row.artist : null,
            "hash": row.hash ? row.hash : null,
            "album": row.album ? row.album : null,
            "track": row.track ? row.track : null,
            "title": row.title ? row.title : null,
            "year": row.year ? row.year : null,
            "album-art": row.aaFile ? row.aaFile : null,
            "filename": fe.basename(row.filepath),
            "rating": row.rating ? row.rating : null
          }
        });
      }
    }
    res.json(songs);
  });

  function escapeRegex(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  mstream.post('/db/rate-song', (req, res) => {
    if (!req.body.filepath || !req.body.rating || req.body.rating < 0 || req.body.rating > 10) {
      return res.status(500).json({ error: `Bad input data ${req.body.filepath} ${req.body.rating}`});
    }

    const pathInfo = program.getVPathInfo(req.body.filepath);
    if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }

    if (!userMetadataCollection || !fileCollection) {
      res.status(500).json({ error: 'No DB' });
      return;
    }

    const result = fileCollection.chain().find({ '$and':[{ 'filepath': {'$regex': [escapeRegex(pathInfo.relativePath), 'i']}}, { 'vpath': pathInfo.vpath }] }).limit(1).data();
    if (result.length < 1 || result[0].hash === undefined) {
      res.status(500).json({ error: `File not found in DB with relpath ${pathInfo.relativePath} and vpath ${pathInfo.vpath}`});
      winston.info(util.inspect(result[0], false, null, true /* enable colors */));
      return;
    }

    var typeSave = '';
    const result2 = userMetadataCollection.chain().find({ '$and':[{ 'hash': result[0].hash}, { 'user': req.user.username }] }).limit(1).data();
    if (result2.length < 1) {
      winston.info(`Inserting object with hash ${result[0].hash}`);
      typeSave = 'insert';
      userMetadataCollection.insert({
        user: req.user.username,
        hash: result[0].hash,
        rating: req.body.rating
      });
    } else {
      typeSave = 'update';
      winston.info(`Updating object for ${req.body.filepath}`);
      result2[0].rating = req.body.rating;
      winston.info(util.inspect(result2[0], false, null, true /* enable colors */));
      userMetadataCollection.update(result2[0]);
    }

    userDataDb.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
        res.status(500).json({error: err});
      }
      else { 
        res.json({savedSong: result[0].hash, typeSave: typeSave});
      }
    });
  });

  mstream.post('/db/delete-rated', (req, res) => {
    if (!req.body.filepath) {
      return res.status(500).json({ error: `A filepath is needed in order to remove a song`});
    };

    const pathInfo = program.getVPathInfo(req.body.filepath);
    if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }

    const result = fileCollection.chain().find({ '$and':[{ 'filepath': {'$regex': [escapeRegex(pathInfo.relativePath), 'i']}}, { 'vpath': pathInfo.vpath }] }).limit(1).data();
    if (result.length < 1 || result[0].hash === undefined){
      res.status(500).json({error: `Could not find file ${req.body.filepath} in collection`});
    }
    else{
      winston.info(`Removing rated song with hash ${result[0].hash}`);
      const obj = userMetadataCollection.chain().find({ '$and':[{ 'hash': result[0].hash}, { 'user': req.user.username }] }).limit(1).data();
      userMetadataCollection.remove(obj);
   
      userDataDb.saveDatabase(err => {
        if (err) {
          winston.error(`DB Save Error : ${err}`);
          res.status(500).json({error: err});
        }
      });
    }

    res.json({});
  });

  mstream.post('/db/clear-rated', (req, res) => {

    if (!userMetadataCollection) {
      res.status(500).json({ error: 'No DB' });
      return;
    }

    const result = userMetadataCollection.clear();

    res.json({});

    userDataDb.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });
  });

  mstream.get('/db/amount-rated-songs', (req, res) => {

    const amountOfRated = userMetadataCollection.find();

    const returnThis = { amountOfRated: amountOfRated.length};

    res.json(returnThis);
  });

  mstream.get('/db/all-rated-songs', (req, res) => {

    var left = userMetadataCollection.chain().find();
    var right = fileCollection.chain();
    const results = left.eqJoin(right, 'hash', 'hash').data();

    const returnThis = { rated: results};

    res.json(returnThis);
  });

  mstream.get('/db/rated-song', (req, res) => {

    const pathInfo = program.getVPathInfo(req.body.filepath);
    if (!pathInfo) { return res.status(500).json({ error: 'Could not find file' }); }

    if (!userMetadataCollection || !fileCollection) {
      res.status(500).json({ error: 'No DB' });
      return;
    }

    const result = fileCollection.find({ '$and':[{ 'filepath': {'$regex': [escapeRegex(pathInfo.relativePath), 'i']}}, { 'vpath': pathInfo.vpath }] });
    if (!result) {
      res.status(500).json({ error: `File not found in DB with relpath ${pathInfo.relativePath} and vpath ${pathInfo.vpath}`});
      return;
    }

    const result2 = userMetadataCollection.findOne({ '$and':[{ 'hash': result.hash}, { 'user': req.user.username }] });

    if (!result2) {
      res.status(500).json({ error: `File with relpath ${pathInfo.relativePath} and vpath ${pathInfo.vpath} is not rated yet`});
      return;
    }
    const returnThis = { song: pathInfo.relativePath, rating: result2.rating};

    res.json(returnThis);
  });



  mstream.post('/db/random-songs', (req, res) => {
    if (!fileCollection) {
      res.status(500).json({ error: 'No files in DB' });
      return;
    };

    // Ignore list
    let ignoreList = [];
    if (req.body.ignoreList && Array.isArray(req.body.ignoreList)) {
      ignoreList = req.body.ignoreList;
    }

    let ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && !req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }

    // // Preference for recently played or not played recently

    let orClause = { '$or': [] };
    for (let vpath of req.user.vpaths) {
      if (req.body.ignoreVPaths && typeof req.body.ignoreVPaths === 'object' && req.body.ignoreVPaths[vpath] === true) {
        continue;
      }
      orClause['$or'].push({ 'vpath': { '$eq': vpath } });
    }

    // Add Rating clause
    let minRating = Number(req.body.minRating);
    let maxRating = Number(req.body.maxRating);
    if (minRating && typeof minRating === 'number' && minRating <= 10 && !minRating < 1 && maxRating && typeof maxRating === 'number' && maxRating <= 10) {
      orClause = {'$and': [
        orClause,
        { 'rating': { '$gte': req.body.minRating }},
        { 'rating': { '$lte': req.body.maxRating }}
      ]};
    }

    const leftFun = function(leftData) {
        return leftData.hash + '-' + req.user.username;
    };

    const results = fileCollection.chain().eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault).find(orClause).data();

    const count = results.length;
    if (count === 0) {
      res.status(444).json({ error: 'No songs that match criteria' });
      return;
    }

    while (ignoreList.length > count * ignorePercentage) {
      ignoreList.shift();
    }

    const returnThis = { songs: [], ignoreList: [] };

    let randomNumber = Math.floor(Math.random() * count);
    while (ignoreList.indexOf(randomNumber) > -1) {
      randomNumber = Math.floor(Math.random() * count);
    }

    const randomSong = results[randomNumber];

    returnThis.songs.push({
      "filepath": fe.join(randomSong.vpath, randomSong.filepath).replace(/\\/g, '/'),
      "metadata": {
        "artist": randomSong.artist ? randomSong.artist : null,
        "hash": randomSong.hash ? randomSong.hash : null,
        "album": randomSong.album ? randomSong.album : null,
        "track": randomSong.track ? randomSong.track : randomSong.filepath,
        "title": randomSong.title ? randomSong.title : null,
        "year": randomSong.year ? randomSong.year : null,
        "album-art": randomSong.aaFile ? randomSong.aaFile : null,
        "rating": randomSong.rating ? randomSong.rating : null
      }
    });

    ignoreList.push(randomNumber);
    returnThis.ignoreList = ignoreList;
    res.json(returnThis);
  });

  mstream.post('/db/search', (req, res) => {
    if (!req.body.search) {
      return res.status(500).json({ error: 'Bad input data' });
    }
    // Get user inputs
    const artists = req.body.noArtists === true ? [] : searchByX(req, 'artist');
    const albums = req.body.noAlbums === true ? [] : searchByX(req, 'album');
    const files = req.body.noFiles === true ? [] : searchByX(req, 'filepath');
    const title = req.body.noTitles === true ? [] : searchByX(req, 'title', 'filepath');

    res.json({artists, albums, files, title });
  });

  function searchByX(req, searchCol, resCol) {
    if (!resCol) {
      resCol = searchCol;
    }

    const returnThis = [];
    if (!fileCollection) { return returnThis; }

    let orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    const findThis = {
      '$and': [
        orClause,
        {[searchCol]: {'$regex': [String(req.body.search), 'i']}}
      ]
    };
    const results = fileCollection.find(findThis);

    const store = {};
    for (let row of results) {
      if (!store[row[resCol]]) {
        let name = row[resCol];
        let filepath = false;

        if (searchCol === 'filepath') {
          name = fe.join(row.vpath, row[resCol]).replace(/\\/g, '/');
          filepath = fe.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        } else if (searchCol === 'title') {
          name = `${row.artist} - ${row.title}`;
          filepath = fe.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        }

        returnThis.push({
          name: name,
          album_art_file: row.aaFile ? row.aaFile : null,
          filepath
        });
        store[row[resCol]] = true;
      }
    }

    return returnThis;
  }

  mstream.get('/db/get-rated', (req, res) => {
    const songs = [];
    if (!fileCollection) {
      res.json(songs);
      return;
    }

    let orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    var mapFun = function(left, right) {
      return {
        artist: right.artist,
        album: right.album,
        hash: right.hash,
        track: right.track,
        title: right.title,
        year: right.year,
        'album-art': right.aaFile,
        filepath: right.filepath,
        rating: left.rating,
        vpath: right.vpath
      };
    };
    
    var leftFun = function(leftData) {
      return leftData.hash + '-' + leftData.user;
    };
    
    var rightFun = function(rightData) {
      return rightData.hash + '-' + req.user.username;
    };

    const results = userMetadataCollection.chain().eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun).find({
      '$and': [
        orClause,
        { 'rating': { '$gt': 0 } }
      ]
    }).simplesort('rating', true).data();

    for (let row of results) {
      songs.push({
        "filepath": fe.join(row.vpath, row.filepath).replace(/\\/g, '/'),
        "metadata": {
          "artist": row.artist ? row.artist : null,
          "hash": row.hash ? row.hash : null,
          "album": row.album ? row.album : null,
          "track": row.track ? row.track : null,
          "title": row.title ? row.title : null,
          "year": row.year ? row.year : null,
          "album-art": row.aaFile ? row.aaFile : null,
          "filename": fe.basename(row.filepath),
          "rating": row.rating ? row.rating : null
        }
      });
    }
    res.json(songs);
  });

  mstream.post('/db/recent/added', (req, res) => {
    let limit = parseInt(req.body.limit);
    if (!limit || typeof limit !== 'number' || limit < 0) {
      limit = 100;
    }

    const songs = [];
    if (!fileCollection) {
      res.json(songs);
      return;
    }

    let orClause;
    if (req.user.vpaths.length === 1) {
      orClause = { 'vpath': { '$eq': req.user.vpaths[0] } }
    } else {
      orClause = { '$or': [] }
      for (let vpath of req.user.vpaths) {
        orClause['$or'].push({ 'vpath': { '$eq': vpath } })
      }
    }

    const leftFun = function(leftData) {
      return leftData.hash + '-' + req.user.username;
    };

    const results = fileCollection.chain().find({
      '$and': [
        orClause, 
        { 'ts': { '$gt': 0 } }
      ]
    }).simplesort('ts', true).limit(limit).eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault).data();

    for (let row of results) {
      songs.push({
        "filepath": fe.join(row.vpath, row.filepath).replace(/\\/g, '/'),
        "metadata": {
          "artist": row.artist ? row.artist : null,
          "hash": row.hash ? row.hash : null,
          "album": row.album ? row.album : null,
          "track": row.track ? row.track : null,
          "title": row.title ? row.title : null,
          "year": row.year ? row.year : null,
          "album-art": row.aaFile ? row.aaFile : null,
          "filename": fe.basename(row.filepath),
          "rating": row.rating ? row.rating : null
        }
      });
    }
    res.json(songs);
  });

  // Load DB on boot
  loadDB();
}
