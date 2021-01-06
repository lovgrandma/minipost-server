/** Recommendations file recommendations.js
@version 0.2
@author Jesse Thompson
Interfaces with neo4j architecture and other dbs, store recommendation and AI functions here
*/
const redis = require('redis');
const redisapp = require('../redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);
const redisclient = redisapp.redisclient;
const rediscontentclient = redisapp.rediscontentclient;

const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const uuidv4 = require('uuid/v4');
const cloudfrontconfig = require('./servecloudfront');
const s3Cred = require('./api/s3credentials.js');
const driver = neo4j.driver(s3Cred.neo.address, neo4j.auth.basic(s3Cred.neo.username, s3Cred.neo.password));
const utility = require('./utility');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');

// This function will create indexes if they do not exist once the application begins running. This function should not be running often or much at all
// since the index will update itself and it does not need to be tinkered with.
const buildIndex = async () => {
    try {
        let session = driver.session();
        let query = "call db.indexes()";
        return await session.run(query)
            .then((result) => {
                session.close();
                let exists = {
                    videos: false,
                    articles: false
                }
                result.records.forEach((record) => {
                    if (record._fields) {
                        record._fields.forEach((field) => {
                            if (field == "videos") {
                                exists.videos = true;
                            } else if (field == "articles") {
                                exists.articles = true;
                            }
                        })
                    }
                })
                if (exists.videos == false) {
                    let session2 = driver.session();
                    let query = "CALL db.index.fulltext.createNodeIndex(\"videos\",[\"Video\"],[\"title\", \"description\", \"author\", \"tags\", \"mpd\", \"thumbnailUrl\", \"views\", \"publishDate\"])";
                    session2.run(query)
                        .then((result) => {
                            session2.close();
                        })
                }
                if (exists.articles == false) {
                    let session3 = driver.session();
                    let query = "CALL db.index.fulltext.createNodeIndex(\"articles\",[\"Article\"],[\"title\", \"body\", \"author\", \"id\", \"thumbnailUrl\", \"reads\", \"publishDate\"])";
                    session3.run(query)
                        .then((result) => {
                            session3.close();
                        })
                }
                return exists;
            })
    } catch (err) {
        // Something went wrong
    }
}

buildIndex(); // Call build index here on server start

// Returns search results for any query along with appending for pagination. User can choose show only videos or articles or both on front end
const getSearchResults = async (value, append = 0, types = { video: true, article: true }) => {
    try {
        if (value) {
            let data = {
                content: [],
                append: 0
            }
            if (value.length > 0) {
                // Determines if session should be run or to just continue on
                let runSession = async (run, session, query) => {
                    if (run && session && query) {
                        return await session.run(query);
                    } else {
                        return [];
                    }
                }
                let session;
                let query;
                let temp = [];
                if (types.video) {
                    session = driver.session();
                    query = "CALL db.index.fulltext.queryNodes(\"videos\", \"" + value + "\") YIELD node, score RETURN node.title, node.description, node.author, node.tags, node.mpd, node.thumbnailUrl, node.views, node.publishDate, score";
                }
                // Determine whether or not to get videos that match search query
                return await runSession(types.video, session, query).then((result) => {
                    if (session) {
                        session.close();
                    }
                    if (result) {
                        if (result.records) {
                            for (let i = 0; i < result.records.length; i++) {
                                if (result.records[i]._fields) {
                                    let doc = {
                                        title: result.records[i]._fields[0],
                                        description: result.records[i]._fields[1],
                                        author: result.records[i]._fields[2],
                                        tags: result.records[i]._fields[3],
                                        mpd: result.records[i]._fields[4],
                                        thumbnailUrl: result.records[i]._fields[5],
                                        views: parseInt(result.records[i]._fields[6]),
                                        publishDate: result.records[i]._fields[7]
                                    }
                                    temp.push(doc);
                                }
                            }
                        }
                    }
                    return temp;
                }).then((temp) => {
                    data.content = data.content.concat(temp);
                    return;
                }).then( async () => {
                    let session2
                    if (types.article) {
                        session2 = driver.session();
                        query = "CALL db.index.fulltext.queryNodes(\"articles\", \"" + value + "\") YIELD node, score RETURN node.title, node.body, node.author, node.id, node.thumbnailUrl, node.reads, node.publishDate, score";
                    }
                    // Determine whether or not to get articles that match search query
                    return await runSession(types.article, session2, query).then((result) => {
                        if (session2) {
                            session2.close();
                        }
                        temp = [];
                        if (result) {
                            if (result.records) {
                                for (let i = 0; i < result.records.length; i++) {
                                    if (result.records[i]._fields) {
                                        let doc = {
                                            title: result.records[i]._fields[0],
                                            body: result.records[i]._fields[1],
                                            author: result.records[i]._fields[2],
                                            id: result.records[i]._fields[3],
                                            thumbnailUrl: result.records[i]._fields[4],
                                            reads: parseInt(result.records[i]._fields[5]),
                                            publishDate: result.records[i]._fields[6]
                                        }
                                        temp.push(doc);
                                    }
                                }
                            }
                        }
                        return temp;
                    }).then((temp) => {
                        data.content = data.content.concat(temp);
                        return data;
                    }).then(() => {
                        if (append > 0) {
                            data.content = data.content.splice(0, append);
                            return data;
                        } else {
                            return data;
                        }
                    })
                })
            }
        }
    } catch (err) {
        // Something went wrong
        return false;
    }
}

module.exports = {
    getSearchResults: getSearchResults
}
