const redis = require('redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);

// Initialize redis client
let redisclient = redis.createClient(); // Creates a redis client
const videoclientoptions = [{db: 1}]; // Selects video database for likes
let rediscontentclient = redis.createClient(videoclientoptions);

// Default redis host is 127.0.0.1, the loopback IP and the default port is 6379. They are defined outside of this file, but are again defined below for
// later reference
let redisport = 6379;
let redishost = "127.0.0.1";

// You can change it with the following function:
// redisclient = redis.createClient(redisport, redishost);

redisclient.on('connect', function() {
    console.log('Redis client connected');
});

rediscontentclient.on('connect', function() {
    console.log('Redis content client connected');
});

redisclient.on('error', function (err) {
    console.log('redisclient: Something went wrong ' + err);
});

rediscontentclient.on('error', function(err) {
    console.log('rediscontentclient: Something went wrong ' + err);
});

module.exports = { redisclient, rediscontentclient, redisport, redishost };
