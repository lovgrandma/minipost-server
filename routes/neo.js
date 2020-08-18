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
const driver = neo4j.driver("bolt://localhost", neo4j.auth.basic("neo4j", "neo4j"));
const uuidv4 = require('uuid/v4');
const cloudfrontconfig = require('./servecloudfront');
const utility = require('./utility');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');

/* Simple neo4j query. Working and shows syntax of method. */
const returnFriends = async () => {
    /* The session can only have one open query at once. Ensure that you never have several queries running at the same time,
    this will crash nodejs. Use .then promise syntax for simplicity */
    const session = driver.session();
    try {
        const query = "match (n) return n";
        /* Await result if you want to use result to make another query. This avoids pyramid callback function style programming */
        const result = await session.writeTransaction
        (tx => tx.run(query)
            .then((result) => {
                /* Syntax for accessing records and record information.
                Always check to ensure that the record has a type of property before you assume it is there */
                result.records.forEach((record) => {
                    if (record._fields[0].properties.name) {
                        console.log(record._fields[0].properties.name);
                    }
                })
                return result;
            })
            .catch((err) => {
                console.log(err);
            })
        )

        console.log(result); // Result can be accessed here since this is async/await method being used properly.
    } catch (err) {
        console.log(err);
    }
}

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
                graphRecords.forEach((record, i) => {
                    graphRecords[i]._fields[0].properties.articles = [];
                    let found = 0;
                    graphRecords.forEach((recordCompare, j) => {
                        if (record._fields[0].properties.mpd === recordCompare._fields[0].properties.mpd) {
                            found++;
                            if (recordCompare._fields[2]) {
                                // Convert all relevant integer fields to correct form. Converts {low: 0, high: 0} form to 0. Push object to array
                                recordCompare._fields[2].properties.likes = parseInt(recordCompare._fields[2].properties.likes);
                                recordCompare._fields[2].properties.dislikes = parseInt(recordCompare._fields[2].properties.dislikes);
                                recordCompare._fields[2].properties.reads = parseInt(recordCompare._fields[2].properties.reads);
                                graphRecords[i]._fields[0].properties.articles.push(recordCompare._fields[2]);
                            }
                            if (found > 1) {
                                graphRecords.splice(j, 1);
                            }
                        }
                    });
                    console.log(record._fields[0].properties.articles);
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
                                return await createOneUser(user);
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
                                                                resolve(await createOneUser(mongoRecord.username));
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
        console.log("Graphdb check users method failed to complete");
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
const createOneUser = async (user) => {
    session = driver.session();
    query = "create (a:Person {name: $username}) return a";
    const userCreated = session.run(query, {username: user })
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
const createOneVideo = async (user, userUuid, mpd, title, description, nudity, tags, publishDate) => {
    if (user && mpd) {
        let videoCreateProcessComplete = checkUserExists(user)
        .then(async (result) => {
            if (!result) {
                return await createOneUser(user)
            }
        })
        .then(async (result) => {
            return await checkVideoExists(mpd);
        })
        .then(async (result) => {
            session = driver.session();
            /* If result is null, create new video else update existing video in graph db */
            if (!result) {
                let query = "create (a:Video { mpd: $mpd, author: $author, authorUuid: $userUuid, title: $title, publishDate: $publishDate, description: $description, nudity: $nudity, tags: $tags, views: 0, likes: 0, dislikes: 0 }) return a";
                let params = { mpd: mpd, author: user, userUuid: userUuid, title: title, publishDate: publishDate, description: description, nudity: nudity, tags: tags };
                const videoRecordCreated = await session.run(query, params)
                    .then((record) => {
                        session.close();
                        return record;
                    })
                    .then((record) => {
                        session = driver.session();
                        // Will merge author node to just created video node in neo4j
                        query = "match (a:Person {name: $author}), (b:Video {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        session.run(query, params);
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
                                console.log(article.responseTo);
                                query = "match (a:Article { id: $id}), (b:Video { mpd: $responseTo }) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            } else if (article.responseType === "article") {
                                query = "match (a:Article { id: $id}), (b:Article { id: $responseTo }) merge (b)-[r:RESPONSE]->(a)";
                                session3.run(query, params);
                            }
                        }
                        if (createdArticle.records.length > 0) {
                            return true;
                        }
                    } else {
                        return false;
                    }
                } else {
                    return false;
                }
            } else {
                return false;
            }
        } else {
            return false;
        }
    } catch (err) {
        console.log(err);
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

const fetchSingleVideoData = async (mpd) => {
    let session = driver.session();
    let query = "match (a:Video {mpd: $mpd}) return a";
    let params = { mpd: mpd };
    let data = {
        video: {},
        relevantVideos: [],
        articleRespones: [],
        videoResponses: []
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
            if (result.records[0]) {
                if (result.records[0]._fields[0]) {
                    video.author = result.records[0]._fields[0].properties.author.toString();
                    video.title = result.records[0]._fields[0].properties.title.toString();
                    video.description = result.records[0]._fields[0].properties.description.toString();
                    video.tags = result.records[0]._fields[0].properties.tags;
                    video.published = result.records[0]._fields[0].properties.publishDate;
                    video.likes = result.records[0]._fields[0].properties.likes.toNumber();
                    video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber();
                    video.views = result.records[0]._fields[0].properties.views.toNumber();
                    return video;
                } else {
                    return video;
                }
            } else {
                return video;
            }
        })
        .then(async (result) => {
            result.mpd = await cloudfrontconfig.serveCloudfrontUrl(mpd);
            return result;
        })
    return data;
};

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

/** Sets video views by passed value */
const setVideoViewsNeo = async (mpd, value) => {
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
}

module.exports = { returnFriends: returnFriends,
                 checkFriends: checkFriends,
                 serveVideoRecommendations: serveVideoRecommendations,
                 createOneVideo: createOneVideo,
                 createOneArticle: createOneArticle,
                 deleteOneArticle: deleteOneArticle,
                 fetchSingleVideoData: fetchSingleVideoData,
                 incrementVideoView: incrementVideoView };
