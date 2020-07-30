/** Neo4j file neo.js
@version 0.2
@author Jesse Thompson
Interfaces with neo4j architecture, updates and appends relationships with relevant data and calls recommendation algorithms
*/

const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const driver = neo4j.driver("bolt://localhost", neo4j.auth.basic("neo4j", "neo4j"));
const uuidv4 = require('uuid/v4');
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
        /* Await result if you wish to use result to make another query. This avoids pyramid callback function style programming */
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

/* Serves video recommendations to client */
const serveVideoRecommendations = async (user) => {
    const videoArray = checkFriends(user).then(() => {
        console.log("preliminary stuff done");
        return "good stuff";
    })
    return videoArray;
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
                                                    /* Add user to graph db if user doesn't exist */
                                                    checkUserExists(mongoRecord.username)
                                                        .then(async (result) => {
                                                        if (!result) {
                                                            resolve(await createOneUser(mongoRecord.username));
                                                        }
                                                        resolve(true);
                                                    })
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
                                                    if (graphRecords.indexOf(mongoRecord.username <= 0)) {
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
                        console.log(completeUserGraphDbCheck);
                        return completeUserGraphDbCheck;
                } else {
                    return false;
                }
            }
        }
        return false;
    } catch (err) {
        console.log("Graphdb check users method failed to complete");
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

const createOneVideo = async (user, mpd, title, description, nudity, tags) => {
    console.log(user, mpd, title, description, nudity, tags);
    if (user && mpd) {
        checkUserExists(user)
        .then(async (result) => {
            if (!result) {
                return await createOneUser(user)
            }
        })
        .then(async (result) => {
            return await checkVideoExists(mpd);
        })
        .then(async (result) => {
            if (!result) {
                session = driver.session();
                let query = "create (a:Video { mpd: $mpd, author: $author";
                let params = { mpd: mpd, author: user }
                if (title) {
                    if (title.length > 0) {
                        query += ",title: $title";
                        params.title = title;
                    }
                }
                if (description) {
                    if (description.length > 0) {
                        query += ",description: $description";
                        params.description = description;
                    }
                }
                if (nudity) {
                    query += ",nudity: true";
                } else {
                    query += ",nudity: false";
                }
                if (tags) {
                    query += ",tags: $tags";
                    params.tags = tags;
                }
                query += " }) return a";
                const videoCreated = await session.run(query, params)
                    .then(async() => {
                        console.log("Video created");
                    })
                console.log(videoCreated);
            }
        })
    }
}

module.exports = { returnFriends: returnFriends,
                 checkFriends: checkFriends,
                 serveVideoRecommendations: serveVideoRecommendations,
                 createOneVideo: createOneVideo };
