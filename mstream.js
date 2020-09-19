const logger = require('./modules/logger');
logger.init();
const winston = require('winston');
const express = require('express');
const mstream = express();
const fs = require('fs');
const bodyParser = require('body-parser');

const dbModule = require('./modules/db-management/database-master.js');
const sync = require('./modules/sync.js');
const defaults = require('./modules/defaults.js');
const ddns = require('./modules/ddns');

exports.serveIt = config => {
  const program = defaults.setup(config);

  // Logging
  if (program.writeLogs) {
    logger.addFileLogger(program.storage.logsDirectory);
  }

  // Set server
  var server;
  if (program.ssl && program.ssl.cert && program.ssl.key) {
    try {
      server = require('https').createServer({
        key: fs.readFileSync(program.ssl.key),
        cert: fs.readFileSync(program.ssl.cert)
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    server = require('http').createServer();
  }

  // Magic Middleware Things
  mstream.use(bodyParser.json({strict: false})); // support json encoded bodies
  mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies
  mstream.use((req, res, next) => { // CORS
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

  // Give access to public folder
  mstream.use('/public', express.static( program.webAppDirectory ));
  // Serve the webapp
  mstream.get('/', (req, res) => {
    res.sendFile('mstream.html', { root: program.webAppDirectory });
  });
  mstream.get('/j/*', (req, res) => {
    res.sendFile( 'mstream.html', { root: program.webAppDirectory });
  });

  // Login functionality
  program.auth = false;
  if (program.users && Object.keys(program.users).length !== 0) {
    require('./modules/login.js').setup(mstream, program, express);
    program.auth = true;
  } else {
    program.users = {
      "mstream-user": {
        vpaths: [],
        username: "mstream-user",
        admin: true
      }
    };

    if (program['lastfm-user'] && program['lastfm-password']) {
      program.users['mstream-user']['lastfm-user'] = program['lastfm-user'];
      program.users['mstream-user']['lastfm-password'] = program['lastfm-password'];
    }

    // Fill in user vpaths
    Object.keys(program.folders).forEach( key => {
      program.users['mstream-user'].vpaths.push(key);
    });

    // Fill in the necessary middleware
    mstream.use((req, res, next) => {
      req.user = program.users['mstream-user'];
      next();
    });
  }

  // Album art endpoint
  // TODO: this should different per user. It should be the same as the music path
  // For now on config we set it up in the config as the same folder
  mstream.use('/album-art', express.static(program.storage.albumArtDirectory));
  // Download Files API
  require('./modules/download.js').setup(mstream, program);
  // File Explorer API
  require('./modules/file-explorer.js').setup(mstream, program);
  // Load database
  dbModule.setup(mstream, program);
  // Transcoder
  if (program.transcode && program.transcode.enabled === true) {
    require("./modules/ffmpeg.js").setup(mstream, program);
  }
  // Scrobbler
  require('./modules/scrobbler.js').setup(mstream, program);

  // TODO: Add middleware to determine if user has access to the exact file
  // Setup all folders with express static
  Object.keys(program.folders).forEach( key => {
    mstream.use('/media/' + key + '/', express.static(program.folders[key].root));
  });

  // Start the server!
  server.on('request', mstream);
  server.listen(program.port, () => {
    const protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://localhost:${program.port}`);

    dbModule.runAfterBoot(program);
    ddns.setup(program);
  });
};
