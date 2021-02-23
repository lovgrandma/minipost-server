const cluster = require('cluster');
const redis = require('redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);
const s3Cred = require('./routes/api/s3credentials.js');

// Default redis host is 127.0.0.1, the loopback IP and the default port is 6379. They are defined outside of this file
let redisport = s3Cred.redis.redisport;
let videoviewslikesport = s3Cred.redis.videoviewslikesport;
let articlereadslikesport = s3Cred.redis.articlereadslikesport;
let adviewsport = s3Cred.redis.adviewsport;
let dailyadlimitsport = s3Cred.redis.dailyadlimitsport;
let channelsubscriptionsport = s3Cred.redis.channelsubscriptionsport;

// Initialize redis client
let redisclient = redis.createClient(); // Original redis client. Contains all information for chats
let videoviewsclient = redis.createClient({port: videoviewslikesport}); // Also used for 
let articlereadsclient = redis.createClient({port: articlereadslikesport });
let adviewsclient = redis.createClient({port: adviewsport });
let dailyadlimitsclient = redis.createClient({port: dailyadlimitsport });
let channelsubscriptionsclient = redis.createClient({port: channelsubscriptionsport });
const videoclientoptions = [{db: 1}]; // Selects video database for likes
let rediscontentclient = redis.createClient(videoclientoptions);

let redishost = s3Cred.redis.redishost;

// You can change it with the following function:
// redisclient = redis.createClient(redisport, redishost);

let resolveLogging = true;
if (cluster.worker) {
    if (cluster.worker.id != 1) {
        resolveLogging = false;
    }
}
if (resolveLogging) {
    redisclient.on('connect', function() {
        console.log('Redis instance connected');
    });
    rediscontentclient.on('connect', function() {
        console.log('Redis content instance connected');
    });
    redisclient.on('error', function (err) {
        console.log('redisclient: Something went wrong ' + err);
    });
    rediscontentclient.on('error', function(err) {
        console.log('rediscontentclient: Something went wrong ' + err);
    });

    videoviewsclient.on('connect', function() {
        console.log('Video views redis instance connected');
    });
    videoviewsclient.on('error', function(err) {
        console.log('videoviewsclient: Something went wrong ' + err);
    });
    articlereadsclient.on('connect', function() {
        console.log('Article views redis instance connected');
    });
    articlereadsclient.on('error', function(err) {
        console.log('articleviewsclient: Something went wrong' + err);
    });
    adviewsclient.on('connect', function() {
        console.log('Ad views redis instance connected');
    });
    adviewsclient.on('error', function(err) {
        console.log('adviewsclient: Something went wrong' + err);
    });
    dailyadlimitsclient.on('connect', function() {
        console.log('Daily ad limits redis instance connected');
    });
    dailyadlimitsclient.on('error', function(err) {
        console.log('dailyadlimitsclient: Something went wrong' + err);
    });
    channelsubscriptionsclient.on('connect', function() {
        console.log('Channel subscriptions redis instance connected');
    });
    channelsubscriptionsclient.on('error', function(err) {
        console.log('channelsubscriptionsclient: Something went wrong' + err);
    });
}

module.exports = { redisclient, rediscontentclient, videoviewsclient, articlereadsclient, adviewsclient, dailyadlimitsclient, channelsubscriptionsclient, redisport, videoviewslikesport, articlereadslikesport, adviewsport, dailyadlimitsport, redishost };
