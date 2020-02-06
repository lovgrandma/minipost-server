const redis = require('redis');

// Initialize redis client
let redisclient = redis.createClient(); // Creates a redis client

// Default redis host is 127.0.0.1, the loopback IP and the default port is 6379
// You can change it with the following function:
// redisclient = redis.createClient(port, host);
let redisport = 6379;
let redishost = "127.0.0.1";

redisclient.on('connect', function() {
    console.log('Redis client connected');
});

redisclient.on('error', function (err) {
    console.log('Something went wrong ' + err);
});

module.exports = { redisclient, redisport, redishost };
