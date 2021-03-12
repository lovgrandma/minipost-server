const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const uuidv4 = require('uuid/v4');
const recommendations = require('./recommendations.js');
const s3Cred = require('./api/s3credentials.js');
const driver = neo4j.driver(s3Cred.neo.address, neo4j.auth.basic(s3Cred.neo.username, s3Cred.neo.password));

// This should get a list of videos that the user would be likely to watch considering their history of recent videos watched
const buildPlaylist = async (user, append = 0) => {
    let returnAmount = 100 - append; // e.g if append has 10 , return 90 new videos. if append has 5, return 95. if append has 0 videos there are 0 videos in the users playlist, return 100.
    let data = {
        videos: [],
        ads: []
    }
    data.videos = await recommendations.getRelevantPlaylist(user, returnAmount); // will pass along user value even if null
    data.ads = await recommendations.getRelevantAds(user); // Get 10 ads.
    return data;
}

module.exports = {
    buildPlaylist: buildPlaylist                 
}