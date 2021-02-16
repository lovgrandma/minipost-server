const redis = require('redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);

// Default redis host is 127.0.0.1, the loopback IP and the default port is 6379. They are defined outside of this file, but are again defined below for
// later reference
let redisport = 6379;
let videoviewslikesport = 6380;
let articlereadslikesport = 6381;
let adviewsport = 6382;
let dailyadlimitsport = 6383;
let channelsubscriptionsport = 6384;

// Initialize redis client
let redisclient = redis.createClient(); // Original redis client. Contains all information for chats
let videoviewsclient = redis.createClient({port: videoviewslikesport}); // Also used for 
let articlereadsclient = redis.createClient({port: articlereadslikesport });
let adviewsclient = redis.createClient({port: adviewsport });
let dailyadlimitsclient = redis.createClient({port: dailyadlimitsport });
let channelsubscriptionsclient = redis.createClient({port: channelsubscriptionsport });
const videoclientoptions = [{db: 1}]; // Selects video database for likes
let rediscontentclient = redis.createClient(videoclientoptions);

let redishost = "127.0.0.1";

// You can change it with the following function:
// redisclient = redis.createClient(redisport, redishost);

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


module.exports = { redisclient, rediscontentclient, videoviewsclient, articlereadsclient, adviewsclient, dailyadlimitsclient, channelsubscriptionsclient, redisport, videoviewslikesport, articlereadslikesport, adviewsport, dailyadlimitsport, redishost };
