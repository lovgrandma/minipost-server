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
const rediscontentclient = redisapp.rediscontentclient;

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

This method should return up to 20 video objects (mpds, titles, authors, descriptions, date, views and thumbnail locations) every time it runs.
*/
const serveVideoRecommendations = async (user = "", append = []) => {
    let videoArray = [];
    if (user) {
        if (user.length > 0) {
            videoArray = checkFriends(user).then((result) => {
                return true;
            })
            .then( async (result) => {
                let originalLength = append.length;
                if (append.length > 0) {
                    append = await removeDuplicates(append.concat(await serveRandomTrendingVideos(user)), "video");
                    if (append.length > 0) {
                        append = append.slice(originalLength, append.length);
                    }
                    return append;
                }
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
    // Do not be confused by following returning 5 videos on client side. The first match will be doubled and removed when Video-RESPONSE-article query is matched
    // Avoid using skip as this may skip over documents that hold article responses
    let skip = Math.floor(Math.random() * 5);
    let query = "match (a:Video) optional match (a:Video)-[r:RESPONSE]->(b:Article) return a, r, b ORDER BY a.views DESC LIMIT 100";
    //let params = { skip: neo4j.int(skip) };
    let getHighestTrending = await session.run(query)
        .then(async (result) => {
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
                    graphRecords = utility.shuffleArray(graphRecords);
                    graphRecords = graphRecords.slice(0, 10);
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

const checkNodeExists = async (id, type = "video") => {
    if (id && typeof id === 'string') {
        if (id.length > 0) {
            let session = driver.session();
            let query = "match ( a:Video {mpd: $id}) return a";
            query = videoOrArticle(type, query);
            const videoFound = await session.run(query, {id: id })
                .then(async (result) => {
                    session.close();
                    if (result.records) {
                        if (result.records.length > 0) { // If one video was found matching said username
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
            return await checkNodeExists(mpd);
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
                query += "tags: $tags";
                params.tags = tags;
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

const fetchSingleVideoData = async (mpd, user) => {
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
                            if (result.records[0]._fields[0].properties.likes.toNumber) {
                                video.likes = result.records[0]._fields[0].properties.likes.toNumber();
                            } else {
                                video.likes = result.records[0]._fields[0].properties.likes;
                            }
                            if (video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber) {
                                video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber();
                            } else {
                                video.dislikes = result.records[0]._fields[0].properties.dislikes;
                            }
                            if (video.views = result.records[0]._fields[0].properties.views.toNumber) {
                                video.views = result.records[0]._fields[0].properties.views.toNumber();
                            } else {
                                video.views = result.records[0]._fields[0].properties.views;
                            }
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
            result.likedDisliked = await getUserLikedDisliked(mpd, "video", user);
            result.mpd = await cloudfrontconfig.serveCloudfrontUrl(mpd);
            return result;
        })
    return data;
};

const fetchSingleArticleData = async (id, user) => {
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
    data.likedDisliked = await getUserLikedDisliked(id, "article", user);
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

// Returns whether or not user liked or disliked a piece of content
const getUserLikedDisliked = async (id, type, user) => {
    try {
        let session = driver.session();
        let query = "optional match ( a:Person { name: $user })-[r:LIKES]->";
        let params = { user: user }
        if (type.normalize().toLocaleLowerCase() == "article") {
            query += "( b:Article { id: $id }) return r union optional match ( a:Person {name: $user })-[r:DISLIKES]->( b:Article {id: $id }) return r";
        } else {
            query += "( b:Video { mpd: $id }) return r union optional match ( a:Person { name: $user })-[r:DISLIKES]->( b:Video { mpd: $id }) return r";
        }
        params.id = id;
        return await session.run(query, params)
            .then((result) => {
                session.close();
                for (const record of result.records) {
                    if (record._fields) {
                        if (record._fields[0]) {
                            if (record._fields[0].type) {
                                if (record._fields[0].type == "LIKES") {
                                    return "likes";
                                } else if (record._fields[0].type == "DISLIKES") {
                                    return "dislikes";
                                }
                            }
                        }
                    }
                };
            })
            .catch((err) => {
                return false;
            })
    } catch (err) {
        return false;
    }

}

// Will check for optional already existing WATCHED relationship and delete, then merge new WATCHED relationship with milliseconds since epoch (january 1, 1970)
const setWatchedRelationship = async (mpd, user) => {
    try {
        const d = new Date().getTime();
        let session = driver.session();
        let query = "match ( a:Person { name: $user }), ( b:Video { mpd: $mpd }) optional match (a)-[r:WATCHED]->(b) delete r merge (a)-[r2:WATCHED { time: $ms }]->(b) return a, r2, b";
        let params = { user: user, ms: d, mpd: mpd };
        return await session.run(query, params)
    } catch (err) {
        return err;
    }
    return false;
}

/** Experimental high frequency increment video views on redis database. Returns boolean
Accurate and reliable incrementation is maintained in redis, record values are simply copied to neo4j */
const incrementVideoView = async (mpd, user) => {
    try {
        let redisAccessible = true;
        let videoExists = await checkNodeExists(mpd);
        if (videoExists) {
            let videoExistsRedis = await rediscontentclient.select(1, async function(err, res) {
                if (res == "OK") {
                    return await rediscontentclient.hgetall(mpd, (err, value) => {
                        if (!err) {
                            return value;
                        }
                        return "failed, do not update";
                    });
                } else {
                    redisAccessible = false;
                }
                return false;
            });
            if (!redisAccessible) {
                return false;
            }
            return await rediscontentclient.select(1, async function(err, res) {
                return await setWatchedRelationship(mpd, user)
                    .then( async (result) => {
                        if (videoExistsRedis == "failed, do not update") {
                            return false;
                        } else if (videoExistsRedis) {
                            rediscontentclient.hincrby(mpd, "views", 1);
                            return await rediscontentclient.hgetall(mpd, (err, value) => {
                                setVideoViewsNeo(mpd, value.views);
                                return true;
                            })
                        } else {
                            rediscontentclient.hmset(mpd, "views", 1, "likes", 0, "dislikes", 0);
                            return await rediscontentclient.hgetall(mpd, (err, value) => {
                                setVideoViewsNeo(mpd, value.views);
                                return true;
                            })
                        }
                    })
            });
        }
    } catch (err) {
        return false;
    }
    return false;
}

// Used critically to remove like of opposite type. If user has liked but dislike was incremented, like must be decremented. Returns appropriate value for redis record update
const reverseLikeOrDislike = (like) => {
    if (like) {
        return "dislikes";
    }
    return "likes";
}

const incrementLikeDislikeRedis = async (type, id, increment, like, user, cleanUp) => {
    try {
        let redisAccesible = true;
        let nodeExists;
        let db = 1;
        let viewsOrReads = "views";
        let likeOrDislike = "likes";
        if (!like) {
            likeOrDislike = "dislikes";
        }
        nodeExists = await checkNodeExists(id, type.normalize().toLocaleLowerCase());
        if (type.normalize().toLocaleLowerCase() == "article") {
            db = 2;
            viewsOrReads = "reads";
        }
        if (nodeExists) {
            // Check if node exists in redis database
            let nodeExistsRedis = new Promise((resolve, reject) => {
                rediscontentclient.select(db, async function(err, res) { // Select article db
                    if (res == "OK") {
                        rediscontentclient.hgetall(id, (err, value) => {
                            console.log(value);
                            if (value) {
                                if (value.likes) {
                                    if (value.likes < 0) {
                                        rediscontentclient.hmset(id, "likes", 0);
                                    }
                                }
                                if (value.dislikes) {
                                    if (value.dislikes < 0) {
                                        rediscontentclient.hmset(id, "dislikes", 0);
                                    }
                                }
                            }
                            if (err) {
                                return reject("failed, do not update");
                            }
                            return resolve(value);
                        });
                    } else {
                        redisAccesible = false;
                        return reject(false);
                    }
                });
            })
            if (!redisAccesible) { // if redis db fails for some reason, simply exit cleanly
                return false;
            }
            // rediscontentclient.hgetall(id, (err, value) =>  will return created media of type
            return new Promise((resolve, reject) => {
                rediscontentclient.select(db, async function(err, res) {
                    nodeExistsRedis
                        .then( async (result) => {
                            if (result == "failed, do not update") {
                                return resolve(false);
                            } else if (result) {
                                if (increment) {
                                    rediscontentclient.hincrby(id, likeOrDislike, 1);
                                    if (cleanUp) {
                                        rediscontentclient.hincrby(id, reverseLikeOrDislike(like), -1);
                                    }
                                } else {
                                    rediscontentclient.hincrby(id, likeOrDislike, -1);
                                }
                                rediscontentclient.hgetall(id, (err, value) => {
                                    if (err) {
                                        return resolve(false);
                                    }
                                    return resolve(value);
                                });
                            } else {
                                if (increment) {
                                    if (like) {
                                        rediscontentclient.hmset(id, viewsOrReads, 1, "likes", 1, "dislikes", 0);
                                    } else {
                                        rediscontentclient.hmset(id, viewsOrReads, 1, "likes", 0, "dislikes", 1);
                                    }
                                }
                                rediscontentclient.hgetall(id, (err, value) => {
                                    if (err) {
                                        return resolve(false);
                                    }
                                    return resolve(value);
                                });
                            }
                        })
                        .catch((err) => {
                            if (err) {
                                return resolve(false);
                            }
                            return resolve(true);
                        })
                });
            });
        }
    } catch (err) {
        return false;
    }
}

/** Sets video views by passed value. Is not incremental which can cause inaccuracy on neo4j. Inconsequential if fails or not working well, can replace with method that
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

// When concatting two arrays of media together, check to see if duplicates are present before merging. Used for appending more videos to client dash
const removeDuplicates = async (media, type = "video") => {
    if (type == "video") {
        for (let i = 0; i < media.length; i++) {
            let found = 0;
            if (media[i]) {
                if (media[i]._fields) {
                    if (media[i]._fields[0]) {
                        if (utility.get(media[i]._fields[0], 'properties.mpd')) {
                            for (let j = 0; j < media.length; j++) {
                                if (media[j]) {
                                    if (media[j]._fields) {
                                        if (media[j]._fields[0]) {
                                            if (utility.get(media[j]._fields[0], 'properties.mpd')) {
                                                if (media[i]._fields[0].properties.mpd == media[j]._fields[0].properties.mpd) {
                                                    if (found > 0) {
                                                        // Cycles to check if any articles were missed by appending duplicate record with higher article response count
                                                        if (media[i]._fields[0].properties.articles.length < media[j]._fields[0].properties.articles.length) {
                                                            media[i]._fields[0].properties.articles = [...media[j]._fields[0].properties.articles];
                                                        }
                                                        media.splice(j, 1);
                                                    }
                                                    found++;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return media;
}

const videoOrArticle = (type, query) => {
    if (type.normalize().toLocaleLowerCase() === "article") {
        query = query.replace(":Video", ":Article");
        query = query.replace("mpd:", "id:");
    }
    return query;
}

// Remove relationship of other type for when other type increments successfully
const cleanUpLikeDislikeRel = async (user, like, type, id) => {
    try {
        let session = driver.session();
        let query = "match ( a:Person {name: $user })-[r:LIKES]->( b:Video {mpd: $id }) delete r return a, r, b"; // Default to remove like from neo4j db
        if (like) {
            query = query.replace("r:LIKES", "r:DISLIKES");
        }
        query = videoOrArticle(type, query);
        let params = { user: user, id: id };
        let relationship = await session.run(query, params);
        if (relationship) {
            session.close();
            if (relationship.records.length == 0) {
                return true;
            }
        }
        return false;
    } catch (err) {
        return false;
    }
    return false;
}

// Adds correct query params for relationships before query is ran to increment or decrement likes/dislikes
const correctQueryForLikeDislike = (query, like, type) => {
    if (!like) {
            query = query.replace("r:LIKES", "r:DISLIKES");
    }
    query = videoOrArticle(type, query);
    return query;
}

const incrementLike = async (like, increment, id, type, user) => {
    try {
        type = type.charAt(0).toUpperCase() + type.slice(1);
        let cleanUp = false;
        // Check user relationships
        let session = driver.session();
        let query = "match ( a:Person { name: $user })-[r:LIKES]->( b:Video { mpd: $id }) return a";
        query = correctQueryForLikeDislike(query, like, type);
        let params = { user: user, id: id };
        if (await checkNodeExists(id, type.normalize().toLocaleLowerCase())) {
            let success = await session.run(query, params)
                .then( async (result) => {
                    session.close();
                    let session2 = driver.session(); // Update user relationships
                    if (result.records.length == 0 && increment) { // If user has not done intended action already and wants to increment
                        query = "match ( a:Person { name: $user }), ( b:Video { mpd: $id }) merge (a)-[r:LIKES]->(b) return a, r, b";
                        query = correctQueryForLikeDislike(query, like, type);
                    } else if (result.records.length > 0 && !increment) { // if user has done action already and wants to decrement
                        query = "match ( a:Person { name: $user })-[r:LIKES]->( b:Video { mpd: $id }) delete r return a, r, b";
                        query = correctQueryForLikeDislike(query, like, type);
                    } else {
                        return false;
                    }
                    let session3 = driver.session();
                    let query2 = "match ( a:Person {name: $user})-[r:LIKES]-( b:Video { mpd: $id }) return a, b, r";
                    if (like) {
                        query2 = query2.replace("r:LIKES", "r:DISLIKES");
                    }
                    query2 = videoOrArticle(type, query2);
                    let otherLikeDislikeExisting = await session3.run(query2, params);
                    if (otherLikeDislikeExisting.records.length > 0) {
                        cleanUp = true;
                    }
                    if (otherLikeDislikeExisting) {
                        let updateRel = await session2.run(query, params);
                        if (updateRel) {
                            session2.close();
                            if (increment && updateRel.records.length > 0) { // Only clean up like/dislike if user is incrementing (useless query if user decrements)
                                let removeRel = await cleanUpLikeDislikeRel(user, like, type, id);
                                return true;
                            }
                            return true;
                        }
                    }
                    return false;
                })
                .then( async (result) => {
                    if (result) {
                        // update video incrementation in redis
                        let redisRecordValues = await incrementLikeDislikeRedis(type, id, increment, like, user, cleanUp);
                        if (!redisRecordValues) {
                            return false;
                        } else {
                            return setContentData(redisRecordValues, type, id); //update neo4j
                        }
                    }
                    return false;
                })
            return success;
        }
        return true;
    } catch (err) {
        console.log(err);
        return false;
    }
    return false;
}

const setContentData = async (values, type, id) => {
    try {
        let viewsOrReads = "views";
        console.log(values);
        if (values.likes) {
            let session = driver.session();
            let query = "match (a:Video {mpd: $id}) set a.likes = $likes, a.dislikes = $dislikes";
            let params = { likes: neo4j.int(values.likes), dislikes: neo4j.int(values.dislikes), id: id };
            if (values.views) {
                query += ", a.views = $views";
                params.views = neo4j.int(values.views);
            }
            query += " return a";
            if (type.normalize().toLocaleLowerCase() == "article") {
                viewsOrReads = "reads";
                query = "match (a:Article {id: $id}) set a.likes = $likes, a.dislikes = $dislikes";
                if (values.reads) {
                    query += ", a.reads = $reads";
                    params.reads = neo4j.int(values.reads);
                }
                query += " return a";
            }
            return await session.run(query, params)
                .then((result) => {
                    return true;
                })
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
                 createOneUser: createOneUser,
                 incrementLike: incrementLike };
