'use strict';

const cluster = require('cluster');
const express = require('express');
const fs = require('fs');
const bodyParser = require('body-parser');
const logger = require("morgan");
const pug = require('pug');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const busboy = require('connect-busboy');
const busboyBodyParser = require('busboy-body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const morgan = require('morgan');
const assert = require('assert');
const redis = require('./redis');
const app = express();
const privateKey = fs.readFileSync('key.pem');
const certificate = fs.readFileSync('cert.pem');
const options = {
    key: privateKey,
    cert: certificate
};
const server = require('https').createServer(options, app); // Set to https to force https connections to api
const io = require('socket.io')(server);
const socketRoutes = require('./socket')(io);
const users = require('./routes/m')(io);
const { resolveLogging } = require('./scripts/logging.js');

const s3Cred = require('./routes/api/s3credentials.js');

// parse incoming requests as json and make it accessible from req body property.
app.use(bodyParser.json({
    type: function(req) {
        if (req.get('content-type')) {
            return req.get('content-type').indexOf('multipart/form-data') !== 0;
        }
    },
    limit: "50mb" // Set higher body parser limit for size of video objects
}));
app.use(bodyParser.urlencoded({ extended: false }));
// parse cookies
app.use(cookieParser('small car big wheels'));

app.use(morgan('combined'))

const mongoOptions = {
    auth: {authdb: s3Cred.mongo.authDb },
    user: s3Cred.mongo.u,
    pass: s3Cred.mongo.p
};
// connect mongoose
mongoose.connect(s3Cred.mongo.address, mongoOptions)
    .then(() => resolveLogging() ? console.log('MongoDB Connected') : null)
    .catch(err => console.log(err));

const db = mongoose.connection;
//mongo error
db.on('error', console.error.bind(console, 'connection error:'));

// mongo store
const store = new MongoDBStore(
    {
        uri: s3Cred.mongo.addressAuth,
        collection: 'sessions'
    }
);

// use sessions for tracking logins
app.use(session({
    secret: 'small car big wheels',
    cookie: {
        // reading session ID cookie is forbidden by default. Change this with httpOnly setting below (set to false).
        // Setting this to true will defend against XSS attacks. Keep true or dont define at all.
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
    },
    store: store,
    resave: true,
    saveUninitialized: false
}));

// Add headers
app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Website you wish to allow to connect
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // Request methods you wish to allow
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, content-type, Accept'); // Request headers you wish to allow
    res.setHeader('Access-Control-Allow-Credentials', true); // Set to true if you need the website to include cookies in the requests sent to the API
    next();
});

// Use Routes
app.use('/m/', users);

// The following disables caching essentially. Dont use this. 
//app.disable('etag')

// Catch errors
store.on('error', function(error) {
    assert.ifError(error);
    assert.ok(false);
});

////// Catch all 404, forward to error handler. 
app.use(function(err, req, res, next) {
    if (!err) {
        var err = new Error('File Not Found');
        err.status = 404;
    }
    next(err);
});

// Custom Error Handler replacing default
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.json({
        error: err.message,
        type: err.type
    });
    // res.redirect('/error=' + "error"); // To pass info in redirect must add relevent info in href.
    // Can use React component to parse url for error information and then load different component.
    // Could also create get request
    console.log(err);
})

const port = process.env.PORT || s3Cred.app.port;
server.setTimeout(10*60*1000);
server.listen(port, () => resolveLogging() ? console.log(`Minipost server started on port ${port}`) : null);

module.exports = {io};
