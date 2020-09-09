/** Neo4j file neo.js
@version 0.2
@author Jesse Thompson
Interfaces with neo4j architecture, updates and appends relationships with relevant data and calls recommendation algorithms
*/
const redis = require('redis');
const redisapp = require('../redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);
const redisclient = redisapp.redisclient;
const redisvideoclient = redisapp.redisvideoclient;

const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const driver = neo4j.driver("bolt://localhost:7687", neo4j.auth.basic("neo4j", "git2003hp7474%"));
const uuidv4 = require('uuid/v4');
const cloudfrontconfig = require('./servecloudfront');
const utility = require('./utility');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');

/* Serves video recommendations to client
Serving video recommendations based on similar people and friends requires for friends of a user to be accurately represented in the database. Running checkFriends before running any recommendation logic ensures that users friends are updated in the database

This method should return up to 100 video mpds, titles, authors, descriptions, date, views and thumbnail locations every time it runs.
*/
const serveVideoRecommendations = async (user = "") => {
    let videoArray = [];
    if (user) {
        if (user.length > 0) {
            videoArray = checkFriends(user).then((result) => {
                if (result) {
                    console.log("preliminary stuff done");
                }
                return true;
            })
            .then( async (result) => {
                return await serveRandomTrendingVideos(user);
            });
        } else {
            return await serveRandomTrendingVideos();
        }
    } else {
        return await serveRandomTrendingVideos();
    }
    return videoArray;
}

/* This is the fallback method for serving video recommendations. This method will in chronological order:
1. Find random videos with highest view counts that user has not watched in 6 months uploaded in last hour
2. "" in last 24 hours
3. "" in last week
4. "" in last month
5. "" in last 6 months
6. "" in last year
7. "" in last 5 years
This is a fallback method incase recommendation system cannot find enough unique high affinity videos user has not watched in 6 months
*/
const serveRandomTrendingVideos = async (user = "") => {
    const session = driver.session();
    //const query = "MATCH (a:Video) OPTIONAL MATCH (a)-[r:RESPONSE*]-(b:Article) RETURN a, r, b ORDER BY a.views DESC limit 50";
    const query = "match (a:Video) optional match (a:Video)-[r:RESPONSE]->(b:Article) return a, r, b ORDER BY a.views DESC limit 50";
    let getHighestTrending = session.run(query)
        .then(async (result) => {
            session.close();
            if (result) {
                let graphRecords = result.records;
                // Remove all records with empty titles. This will remove videos that have been uploaded to db but have not yet been published by user
                graphRecords.forEach((record, i) => {
                    if (record._fields) {
                        if (record._fields[0]) {
                            if (record._fields[0].properties) {
                                if (!record._fields[0].properties.title) {
                                    graphRecords.splice(i, 1);
                                }
                            }
                        }
                    }
                })
                graphRecords.forEach((record, i) => {
                    graphRecords[i]._fields[0].properties.articles = [];
                    let found = 0;
                    for (let j = 0; j < graphRecords.length; j++) {
                        if (record._fields[0].properties.mpd === graphRecords[j]._fields[0].properties.mpd) {
                            found++;
                            if (graphRecords[j]._fields[2]) {
                                // Convert all relevant integer fields to correct form. Converts {low: 0, high: 0} form to 0. Push object to array
                                graphRecords[j]._fields[2].properties.likes = parseInt(graphRecords[j]._fields[2].properties.likes);
                                graphRecords[j]._fields[2].properties.dislikes = parseInt(graphRecords[j]._fields[2].properties.dislikes);
                                graphRecords[j]._fields[2].properties.reads = parseInt(graphRecords[j]._fields[2].properties.reads);
                                record._fields[0].properties.articles.push(graphRecords[j]._fields[2]);
                            }
                            if (found > 1) {
                                graphRecords.splice(j, 1);
                                j--;
                            }
                        }
                    }
                    let views = 0;
                    if (record._fields[0].properties.views) {
                        views = record._fields[0].properties.views.toNumber();
                    }
                    graphRecords[i]._fields[0].properties.views = views;
                });
                if (graphRecords) {
                    return graphRecords;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        })
    return getHighestTrending;
}

/* This is the second fallback method. It recommends videos user has not watched in 6 months based on what friends and friends of friends have watched */
const serveFriendsVideos = async (user) => {

}

/* This is the ideal method of video recommendation. It recommends videos based on alike users across the database.
This method will in chronological order:
1. Find high affinity videos user has not watched in 6 months of users with a 90% affinity
a. uploaded in last 24 hours, b. uploaded in last week, c. uploaded in last month, d. uploaded in last 6 months, e. uploaded in last year, f. uploaded in last 5 years
2. "" with a 80% affinity a, b, c, d, e, f
3. "" with a 70% affinity a, b, c, d, e, f
4. "" with a 60% affinity a, b, c, d, e, f
5. "" with a 50% affinity a, b, c, d, e, f
*/
const serveCollaborativeFilterVideos = async (user) => {

}

/* Determines if friends listed in user document in mongodb are analogous to users' neo4j friend relationship edges */
const checkFriends = async (user) => {
    try {
        if (user && typeof user === 'string') {
            if (user.length > 0) {
                let userDoc = await User.findOne({username: user}).lean();
                if (userDoc) {
                    const mongoFriends = userDoc.friends[0].confirmed;
                    const session = driver.session();
                    let completeUserGraphDbCheck = await checkUserExists(user)
                        .then(async(result) => {
                            if (!result) { // If user does not exist, add single new user to graph database
                                return await createOneUser(user, userDoc._id);
                            }
                            return;
                        })
                        .then(async (result) => {
                            const query = "match (a:Person {name: $username })-[r:FRIENDS]-(b) return b";
                            let checkFriendMatches = await session.run(query, {username: user })
                                .then(async (result) => {
                                    session.close();
                                    let graphRecords = result.records;
                                    if (result.records.length > 0) {
                                        let temp = [];
                                        graphRecords.forEach((record) => {
                                            temp.push(record._fields[0].properties.name.toString());
                                        })
                                        graphRecords = temp;
                                    }
                                    if (graphRecords) {
                                        /* If user friends listed in mongoDb user document are not present in graph database, the following first ensures users exist as individual documents in mongoDb */
                                        let promiseCheckFriends = mongoFriends.map(mongoRecord => {
                                            return new Promise( async (resolve, reject) => {
                                                if (graphRecords.indexOf(mongoRecord.username) < 0) { // Check if mongoRecord string present in graph records array
                                                    let otherUser = await User.findOne({username: mongoRecord.username}).lean();
                                                    if (otherUser) {
                                                        /* Add user to graph db if user exists in mongo but not present in graph db */
                                                        checkUserExists(mongoRecord.username)
                                                            .then(async (result) => {
                                                            if (!result) {
                                                                resolve(await createOneUser(mongoRecord.username, otherUser._id ));
                                                            }
                                                            resolve(true);
                                                        })
                                                    } else {
                                                        mongoFriends.filter(record => record !== mongoRecord); // Untested. Should delete record from mongoFriends array since user was not found in mongoDb.
                                                        resolve(true);
                                                    }
                                                } else {
                                                    resolve(true);
                                                }
                                            })
                                        })

                                        /* Determine if mongoFriends array is the same as graphRecord friends array, avoids running unnecessary i/o calls on mongodb and neo4j */
                                        if (!utility.deepEquals(mongoFriends, graphRecords)) {
                                            let checkAndAddFriends = await Promise.all(promiseCheckFriends).then( async (result) => {
                                                const checkFriendsAdded= await Promise.all(mongoFriends.map(mongoRecord => {
                                                    return new Promise (async (resolve, reject) => {
                                                        if (graphRecords.indexOf(mongoRecord.username < 0)) {
                                                            resolve(await mergeOneFriendEdge(user, mongoRecord.username));
                                                        }
                                                        resolve(true);
                                                    })
                                                }));
                                                return checkFriendsAdded;
                                            });
                                            return checkAndAddFriends;
                                        }
                                    } else {
                                        return false;
                                    }
                                })
                            return await checkFriendMatches;
                        })
                        return completeUserGraphDbCheck;
                } else {
                    return false;
                }
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

/* Check if individual mongo user is represented in graph database */
const checkUserExists = async (user) => {
    if (user && typeof user === 'string') {
        if (user.length > 0) {
            let session = driver.session();
            let query = "match (a:Person {name: $username }) return a";
            const userFound = await session.run(query, {username: user })
                .then(async (result) => {
                    session.close();
                    if (result.records) {
                        if (result.records.length > 0) { // If one user was found matching said username
                            return true;
                        } else {
                            return false;
                        }
                    }
                })
            return userFound;
        }
        return false;
    }
    return false;
}

const checkVideoExists = async (mpd) => {
    if (mpd && typeof mpd === 'string') {
        if (mpd.length > 0) {
            let session = driver.session();
            let query = "match (a:Video {mpd: $mpd}) return a";
            const videoFound = await session.run(query, {mpd: mpd })
                .then(async (result) => {
                    session.close();
                    if (result.records) {
                        if (result.records.length > 0) { // If one user was found matching said username
                            return true;
                        } else {
                            return false;
                        }
                    }
                })
            return videoFound;
        }
        return false;
    }
    return false;
}

/* Add one user to graph database */
const createOneUser = async (user, id) => {
    session = driver.session();
    query = "create (a:Person {name: $username, id: $id }) return a";
    const userCreated = session.run(query, { username: user, id: id })
        .then(async(result) => {
            session.close();
            if (result) {
                if (result.records[0]) {
                    return true;
                }
            }
            return false;
        })
    return userCreated;
}

/* Adds one unidirectional friend edge. Ensure that such users have been created first using other helper functions. To match both ways with match queries simply do not specify direction */
const mergeOneFriendEdge = async (user, to) => {
    session = driver.session();
    const query = "match (a:Person {name: $username }), (b:Person {name: $username2}) merge (a)-[r:FRIENDS]-(b) return a, b";
    const friendEdgeAdded = session.run(query, {username: user, username2: to})
        .then(async (result) => {
            if (result) {
                return true;
            }
            return false;
        })
    return friendEdgeAdded;
}

/** Creates or updates one video record in graph db. Returns full record
Requires user, users uuid and mpd. Other methods must be empty string or in tags case must be empty array.
*/
const createOneVideo = async (user, userUuid, mpd, title, description, nudity, tags, publishDate, responseTo, responseType, thumbnailUrl = null) => {
    if (user && mpd) {
        let videoCreateProcessComplete = checkUserExists(user)
        .then(async (result) => {
            if (!result) {
                return await createOneUser(user, userUuid);
            }
        })
        .then(async (result) => {
            return await checkVideoExists(mpd);
        })
        .then(async (result) => {
            session = driver.session();
            /* If result is null, create new video else update existing video in graph db */
            if (!result) {
                if (!description) {
                    description = "";
                }
                if (!tags) {
                    tags = [];
                }
                let query = "create (a:Video { mpd: $mpd, author: $user, authorUuid: $userUuid, title: $title, publishDate: $publishDate, description: $description, nudity: $nudity, tags: $tags, views: 0, likes: 0, dislikes: 0, thumbnailUrl: $thumbnailUrl }) return a";
                let params = { mpd: mpd, user: user, userUuid: userUuid, title: title, publishDate: publishDate, description: description, nudity: nudity, tags: tags, thumbnailUrl: thumbnailUrl };
                const videoRecordCreated = await session.run(query, params)
                    .then(async (record) => {
                        session.close();
                        let session2 = driver.session();
                        // Will merge author node to just created video node in neo4j
                        query = "match (a:Person {name: $user}), (b:Video {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        session2.run(query, params);
                        return record;
                    })
                    .then(async (record) => {
                        if (responseTo) {
                            let session3 = driver.session();
                            params = { mpd: mpd, responseTo: responseTo };
                            if (responseType == "video") {
                                query = "match (a:Video { mpd: $mpd}), (b:Video { mpd: $responseTo}) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            } else if (responseType == "article") {
                                query = "match (a:Video { mpd: $mpd}), (b:Article { id: $responseTo}) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            }
                        }
                        return record;
                    });
                return videoRecordCreated;
            } else {
                let query = "match (a:Video { mpd: $mpd }) set a += { ";
                let params = { mpd: mpd, author: user, userUuid: userUuid, title: title };
                let addedOne = 0;
                if (title) {
                    if (title.length > 0) {
                        query += "title: $title";
                        params.title = title;
                        addedOne++;
                    }
                }
                addedOne > 0 ? query += ", " : null;
                addedOne = 0;
                if (publishDate) {
                    if (publishDate.length > 0) {
                        query += "publishDate: $publishDate";
                        params.publishDate = publishDate;
                        addedOne++;
                    }
                }
                addedOne > 0 ? query += ", " : null;
                addedOne = 0;
                if (thumbnailUrl) {
                    if (thumbnailUrl.length > 0) {
                        query += "thumbnailUrl: $thumbnailUrl";
                        params.thumbnailUrl = thumbnailUrl;
                        addedOne++;
                    }
                }
                addedOne > 0 ? query += ", " : null;
                addedOne = 0;
                if (description) {
                    if (description.length > 0) {
                        query += "description: $description";
                        params.description = description;
                        addedOne++;
                    }
                }
                addedOne > 0 ? query += ", " : null;
                addedOne = 0;
                if (nudity) {
                    query += "nudity: true";
                    addedOne++;
                } else {
                    query += "nudity: false";
                    addedOne++;
                }
                addedOne > 0 ? query += ", " : null;
                addedOne = 0;
                if (tags) {
                    query += "tags: $tags";
                    params.tags = tags;
                }
                query += " } return a";
                const videoRecordUpdated = await session.run(query, params)
                    .then(async (record) => {
                        session.close();
                        let session2 = driver.session();
                        // Will merge author node to just created video node in neo4j
                        query = "match (a:Person {name: $user}), (b:Video {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        session2.run(query, params);
                        return record;
                    })
                    .then(async (record) => {
                        if (responseTo) {
                            let session3 = driver.session();
                            params = { mpd: mpd, responseTo: responseTo };
                            if (responseType == "video") {
                                query = "match (a:Video { mpd: $mpd}), (b:Video { mpd: $responseTo}) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            } else if (responseType == "article") {
                                query = "match (a:Video { mpd: $mpd}), (b:Article { id: $responseTo}) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            }
                        }
                        return record;
                    });
                return videoRecordUpdated;
            }
        })
        return videoCreateProcessComplete;
    }
}

/* Creates one article node on neo4j and merges user ((author)-[r:PUBLISHED]->(article)) to article neo4j node */
const createOneArticle = async (article) => {
    try {
        if (article._id && article.author && article.title && article.body) {
            if (article._id.length > 0 && article.author.length > 0 && article.title.length > 0 && article.body.length > 0) {
                // Initial check to see if article with same id already exists
                let session = driver.session();
                let query = "match (a:Article { id: $id }) return a";
                let params = { id: article._id };
                let nodeExists = await session.run(query, params);
                if (!nodeExists || nodeExists.records.length == 0) {
                    session.close();
                    let session2 = driver.session();
                    query = "match (a:Person { name: $author }) create (b:Article { id: $id, author: $author, title: $title, body: $body, publishDate: $publishDate, reads: 0, likes: 0, dislikes: 0 }) merge (a)-[r:PUBLISHED]->(b) return b"
                    params = { id: article._id, author: article.author, title: article.title, body: article.body, publishDate: article.publishDate };
                    // Create article with relationship to author
                    let createdArticle = await session2.run(query, params)
                    if (createdArticle) {
                        session2.close();
                        let session3 = driver.session();
                        if (article.responseTo && article.responseType) {
                            params = { id: article._id, responseTo: article.responseTo };
                            if (article.responseType === "video") {
                                query = "match (a:Article { id: $id}), (b:Video { mpd: $responseTo }) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params); // Run method to create relationships between video and article as response to video
                            } else if (article.responseType === "article") {
                                query = "match (a:Article { id: $id}), (b:Article { id: $responseTo }) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            }
                        }
                        if (createdArticle.records.length > 0) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

/* Deletes one article from database. This should almost always never be called even if user deletes profile. Only call if error creating article on mongoDb to maintain consistency */
const deleteOneArticle = async (id) => {
    try {
        if (id) {
            if (id.length > 0) {
                let session = driver.session();
                let query = "match (a:Article { id: $id })-[r]-() delete a, r";
                let params = { id: id };
                let completeDeletion = await session.run(query, params);
                if (completeDeletion) {
                    session.close();
                    return true;
                }
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

// Sometimes there can be records with empty fields. This will ensure that errors do not occur when trying to access nonexistent data members
const resolveEmptyData = (record, type, dataType = "string") => {
    let placeholder = "";
    if (dataType == "number") {
        placeholder = 0;
    } else if (dataType == "array") {
        placeholder = [];
    }
    if (!record._fields[0].properties[type] || record._fields[0].properties[type] == null) {
        return placeholder;
    } else {
        if (dataType == "array") { // Tags data may not be stored properly. May be stored as comma seperated strings or as array. Conditionally return data for both
            if (Array.isArray(record._fields[0].properties[type])) {
                return record._fields[0].properties[type];
            } else {
                return record._fields[0].properties[type].split(",");
            }
        }
        return record._fields[0].properties[type];
    }
    return "";
}

const fetchSingleVideoData = async (mpd) => {
    let session = driver.session();
    // Must query for original video and potential relational matches to articles. Not either/or or else query will not function properly
    let query = "match (a:Video {mpd: $mpd}) optional match (a)-[r:RESPONSE]->(b) optional match (c)-[r2:RESPONSE]->(a) return a, r, b, c";
    let params = { mpd: mpd };
    let data = {
        video: {},
        relevantVideos: [],
        articleResponses: [],
        videoResponses: [],
        responseTo: {}
    }
    data.video = await session.run(query, params)
        .then(async (result) => {
            session.close();
            let video = {
                mpd: "",
                author: "",
                title: "",
                description: "",
                tags: [],
                published: "",
                likes: "",
                dislikes: "",
                views: ""
            }
            // For each result records are stored in the chronological order that you return variables.
            // Here there are 4 variables. result.records[0]._fields[0] should store the original record a you are looking for
            // result.records[0]._fields[1] contains relationship info. This is generally not needed.
            // result.records[i]._fields[2] contains b, the responses of a. Iterate through result.records[i].fields[2] for all responses video and article.
            // result.records[i]._fields[2].labels[0] stores whether document is Article or Video
            // result.records[0]._fields[3] contains c. This is the original document this document is responding to
            if (result) {
                if (result.records[0]) {
                    if (result.records[0]._fields[0]) {
                        if (result.records[0]._fields[0].properties) {
                            video.author = result.records[0]._fields[0].properties.author.toString();
                            video.title = result.records[0]._fields[0].properties.title.toString();
                            video.description = resolveEmptyData(result.records[0], "description"); // Unrequired data member
                            video.tags = resolveEmptyData(result.records[0], "tags", "array"); // Unrequired data member
                            video.published = result.records[0]._fields[0].properties.publishDate;
                            video.likes = result.records[0]._fields[0].properties.likes.toNumber();
                            video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber();
                            video.views = result.records[0]._fields[0].properties.views.toNumber();
                            video.mpd = result.records[0]._fields[0].properties.mpd;
                            video.thumbnail = resolveEmptyData(result.records[0], "thumbnailUrl");
                            // Append article and video responses of this video to articleResponses data member
                            for (let i = 0; i < result.records.length; i++) { // Only iterate through 3rd field (_fields[2]). That holds cypher variable b
                                if (result.records[i]) {
                                    if (result.records[i]._fields[2]) {
                                        if (result.records[i]._fields[2].properties) {
                                            if (result.records[i]._fields[2].labels[0] == "Article") {
                                                result.records[i]._fields[2].properties.likes = parseInt(result.records[i]._fields[2].properties.likes);
                                                result.records[i]._fields[2].properties.dislikes = parseInt(result.records[i]._fields[2].properties.dislikes);
                                                result.records[i]._fields[2].properties.reads = parseInt(result.records[i]._fields[2].properties.reads);
                                                data.articleResponses.push(result.records[i]._fields[2].properties);
                                            } else if (result.records[i]._fields[2].labels[0] == "Video" && result.records[i]._fields[2].properties.mpd != video.mpd) {
                                                result.records[i]._fields[2].properties.likes = parseInt(result.records[i]._fields[2].properties.likes);
                                                result.records[i]._fields[2].properties.dislikes = parseInt(result.records[i]._fields[2].properties.dislikes);
                                                result.records[i]._fields[2].properties.views = parseInt(result.records[i]._fields[2].properties.views);
                                                data.videoResponses.push(result.records[i]._fields[2].properties);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (result.records[0]._fields[3]) { // Only look 4th field (_fields[3]) That holds cypher variable c. Parent document is responding to
                            if (result.records[0]._fields[3].properties) {
                                if (result.records[0]._fields[3].labels[0] == "Video") {
                                    result.records[0]._fields[3].properties.likes = parseInt(result.records[0]._fields[3].properties.likes);
                                    result.records[0]._fields[3].properties.dislikes = parseInt(result.records[0]._fields[3].properties.dislikes);
                                    result.records[0]._fields[3].properties.views = parseInt(result.records[0]._fields[3].properties.views);
                                    result.records[0]._fields[3].properties.type = "video";
                                    data.responseTo = result.records[0]._fields[3].properties;
                                } else if (result.records[0]._fields[3].labels[0] == "Article") {
                                    result.records[0]._fields[3].properties.likes = parseInt(result.records[0]._fields[3].properties.likes);
                                    result.records[0]._fields[3].properties.dislikes = parseInt(result.records[0]._fields[3].properties.dislikes);
                                    result.records[0]._fields[3].properties.reads = parseInt(result.records[0]._fields[3].properties.reads);
                                    result.records[0]._fields[3].properties.type = "article";
                                    data.responseTo = result.records[0]._fields[3].properties;
                                }
                            }
                        }
                        return video;
                    }
                }
            }
            return video;
        })
        .then(async (result) => {
            result.mpd = await cloudfrontconfig.serveCloudfrontUrl(mpd);
            return result;
        })
    return data;
};

const fetchSingleArticleData = async (id) => {
    let session = driver.session();
    let query = "match (a:Article {id: $id}) optional match (a)-[r:RESPONSE]->(b) optional match (c)-[r2:RESPONSE]->(a) return a, r, b, c";
    let params = {id};
    let data = {
        article: {},
        relevantArticles: [],
        articleResponses: [],
        videoResponses: [],
        responseTo: []
    }
    data.article = await session.run(query, params)
        .then(async (result) => {
            session.close();
            let article = {
                id: "",
                author: "",
                title: "",
                body: "",
                published: "",
                likes: "",
                dislikes: "",
                reads: ""
            }
            if (result) {
                if (result.records[0]) {
                    if (result.records[0]._fields[0]) {
                        if (result.records[0]._fields[0].properties) {
                            article.id = result.records[0]._fields[0].properties.id;
                            article.author = result.records[0]._fields[0].properties.author.toString();
                            article.title = result.records[0]._fields[0].properties.title.toString();
                            article.body = result.records[0]._fields[0].properties.body.toString();
                            article.published = result.records[0]._fields[0].properties.publishDate;
                            article.likes = result.records[0]._fields[0].properties.likes.toNumber();
                            article.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber();
                            article.reads = result.records[0]._fields[0].properties.reads.toNumber();
                            // Append article responses of this article to articleResponses data member
                            for (let i = 0; i < result.records.length; i++) {
                                if (result.records[i]) {
                                    if (result.records[i]._fields[2]) {
                                        if (result.records[i]._fields[2].properties) {
                                            if (result.records[i]._fields[2].labels[0] == "Article" && result.records[i]._fields[2].properties.id != article.id) {
                                                result.records[i]._fields[2].properties.likes = parseInt(result.records[i]._fields[2].properties.likes);
                                                result.records[i]._fields[2].properties.dislikes = parseInt(result.records[i]._fields[2].properties.dislikes);
                                                result.records[i]._fields[2].properties.reads = parseInt(result.records[i]._fields[2].properties.reads);
                                                data.articleResponses.push(result.records[i]._fields[2].properties);
                                            } else if (result.records[i]._fields[2].labels[0] == "Video") {
                                                result.records[i]._fields[2].properties.likes = parseInt(result.records[i]._fields[2].properties.likes);
                                                result.records[i]._fields[2].properties.dislikes = parseInt(result.records[i]._fields[2].properties.dislikes);
                                                result.records[i]._fields[2].properties.views = parseInt(result.records[i]._fields[2].properties.views);
                                                data.videoResponses.push(result.records[i]._fields[2].properties);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (result.records[0]._fields[3]) { // Only look 4th field (_fields[3]) That holds cypher variable c. Parent document is responding to
                            if (result.records[0]._fields[3].properties) {
                                if (result.records[0]._fields[3].labels[0] == "Video") {
                                    result.records[0]._fields[3].properties.likes = parseInt(result.records[0]._fields[3].properties.likes);
                                    result.records[0]._fields[3].properties.dislikes = parseInt(result.records[0]._fields[3].properties.dislikes);
                                    result.records[0]._fields[3].properties.views = parseInt(result.records[0]._fields[3].properties.views);
                                    result.records[0]._fields[3].properties.type = "video";
                                    data.responseTo = result.records[0]._fields[3].properties;
                                } else if (result.records[0]._fields[3].labels[0] == "Article") {
                                    result.records[0]._fields[3].properties.likes = parseInt(result.records[0]._fields[3].properties.likes);
                                    result.records[0]._fields[3].properties.dislikes = parseInt(result.records[0]._fields[3].properties.dislikes);
                                    result.records[0]._fields[3].properties.reads = parseInt(result.records[0]._fields[3].properties.reads);
                                    result.records[0]._fields[3].properties.type = "article";
                                    data.responseTo = result.records[0]._fields[3].properties;
                                }
                            }
                        }
                        return article;
                    }
                }
            }
            return article;
        })
    return data;
}
/** Experimental high frequency increment video views on redis database. Returns boolean */
const incrementVideoView = async (mpd) => {
    let videoExists = await checkVideoExists(mpd);
    if (videoExists) {
        let videoExistsRedis = redisvideoclient.hgetall(mpd);
        if (videoExistsRedis) {
            redisvideoclient.hincrby(mpd, "views", 1);
            return await redisvideoclient.hgetall(mpd, (err, value) => {
                setVideoViewsNeo(mpd, value.views);
                return true;
            })
        } else {
            redisvideoclient.hmset(mpd, "views", 1, "likes", 0, "views", 0);
            return await redisvideoclient.hgetall(mpd, (err, value) => {
                setVideoViewsNeo(mpd, value.views);
                return true;
            })
        }
    } else {
        return false;
    }
}

/** Sets video views by passed value. Is not incremental which may cause issues. Inconsequential if fails or not working well, can replace with method that
updates all neo4j video records on schedule. Views are reliably incremented with redis */
const setVideoViewsNeo = async (mpd, value) => {
    try {
        if (parseInt(value)) {
            let session = driver.session();
            let query = "match (a:Video {mpd: $mpd}) set a.views = $views return a";
            let params = { mpd: mpd, views: neo4j.int(value) };
            return await session.run(query, params)
                .then((result) => {
                session.close();
                if (result) {
                    return true;
                } else {
                    return false;
                }
            })
        } else {
            return false;
        }
    } catch (err) {
        return false;
    }
}

module.exports = { checkFriends: checkFriends,
                 serveVideoRecommendations: serveVideoRecommendations,
                 createOneVideo: createOneVideo,
                 createOneArticle: createOneArticle,
                 deleteOneArticle: deleteOneArticle,
                 fetchSingleVideoData: fetchSingleVideoData,
                 fetchSingleArticleData: fetchSingleArticleData,
                 incrementVideoView: incrementVideoView,
                 createOneUser: createOneUser };
