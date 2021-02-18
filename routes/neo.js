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
const videoviewsclient = redisapp.videoviewsclient;
const articlereadsclient = redisapp.articlereadsclient;
const adviewsclient = redisapp.adviewsclient;
const dailyadlimitsclient = redisapp.dailyadlimitsclient;
const channelsubscriptionsclient = redisapp.channelsubscriptionsclient;
const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const uuidv4 = require('uuid/v4');
const cloudfrontconfig = require('./servecloudfront');
const s3Cred = require('./api/s3credentials.js');
const driver = neo4j.driver(s3Cred.neo.address, neo4j.auth.basic(s3Cred.neo.username, s3Cred.neo.password));
const contentutility = require('./contentutility.js');
const processprofanity = require('./processprofanity.js');
const recommendations = require('./recommendations.js');
const utility = require('./utility.js');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');
const aws = require('aws-sdk');
const s3 = new aws.S3();

/* Serves video recommendations to client
Serving video recommendations based on similar people and friends requires for friends of a user to be accurately represented in the database. Running checkFriends before running any recommendation logic ensures that users friends are updated in the database

This method should return up to 20 video objects (mpds, titles, authors, descriptions, date, views and thumbnail locations) every time it runs.
*/
const serveVideoRecommendations = async (user = "", append = []) => {
    let videoArray = [];
    let originalLength = append.length;
    if (user) {
        videoArray = checkFriends(user).then((result) => {
            return true;
        })
        .then( async (result) => {
            // If the length of the existing set of videos is greater than 0 then append and remove duplicates
            // This function should incrementally get best videos using a loop until the length has reached a certain threshold.
            // E.g get best recommended videos up to 15 and then return. E.g get 3 best recommended videos uploaded in last 24 hours, if only 2, go next and get best recommended videos in last week up to 4, returns 4. Return best in last month up to 3, returns 3. Get best in 6 months up to 3 returns 3. Get best in last year, returns 3. Total of 15 videos, remove duplicates, return all.
            // Best would simply mean provided the videos this user has watched recently, return videos of similarity (similarity being:
            // get watched videos of other users that have watched this same video by highest aggreggated watch count )
            // so pass user, watched or unwatched filter to determine if to return watched videos, possibly a history maybe
            if (append.length > 0) {
                append = await removeDuplicates(append.concat(await serveRandomTrendingVideos(user))); // Will retrieve random trending videos, not relating to user watch history
                if (append.length > 0) {
                    append = append.slice(originalLength, append.length);
                }
                return append;
            }
            // Else return first set of videos
            return await serveRandomTrendingVideos(user);
        })
        .catch((err) => {
            console.log(err);
        })
    } else {
        // if we cannot get a username from the request then we will have to return random trending videos
        append = await removeDuplicates(append.concat(await serveRandomTrendingVideos()));
        if (append.length > 0) {
            append = append.slice(originalLength, append.length);
        }
        return append;
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
const serveRandomTrendingVideos = async (user = "", amount = 10) => {
    const session = driver.session();
    const session2 = driver.session();
    // Do not be confused by following returning 5 videos on client side. The first match will be doubled and removed when Video-RESPONSE-article query is matched
    // Avoid using skip as this may skip over documents that hold article responses
    let skip = Math.floor(Math.random() * 5);
    // Why search for videos when gVideos are the only videos that are quarantined to be displayed?
    // We search for all for now because this is what initiates the request to amazon to check if video profanity results are complete
    // There can be a more sophisticated way of doing this in the future by doing cron jobs every x minutes to check profanity on all video labels with status that is not equal to good and only search gVideos in random trending videos
    let query = "match (a:Video)-[:PUBLISHED]-(c:Person) optional match (a)-[r:RESPONSE]->(b) return a, r, b, c.avatarurl ORDER BY a.views DESC LIMIT 100";
    let query2 = "match (a:Article)-[:PUBLISHED]-(c:Person) optional match (a)-[r:RESPONSE]->(b) return a, r, b, c.avatarurl ORDER BY a.reads DESC LIMIT 100";
    //let params = { skip: neo4j.int(skip) };
    let getHighestTrending = await session.run(query)
        .then(async (result) => {
            if (result) {
                let graphRecords = result.records;
                graphRecords = await contentutility.removeInvalidVideos(graphRecords); // Remove invalid record that have not been published/dont have video/profanity
                let articles = await session2.run(query2)
                    .then(async (result2) => {
                        return result2.records;    
                    });
                if (articles && graphRecords) {
                    return graphRecords.concat(articles);
                } else {
                    return graphRecords;
                }
            } else {
                return false;
            }
        }).then( async (data) => {
            if (data) {
                data = contentutility.appendResponses(data); // Append article responses to content // Change to append responses
                if (data) {
                    data = utility.shuffleArray(data); // Shuffle records as to not refer strictly the top 10
                    // get amount and find percentages that would amount to x amount of videos, x amount of articles. 
                    // Do this to determine the ratio of videos to articles, e.g 70% videos, 30% articles
                    data = data.slice(0, amount); // Slice videos down to 10 out of potential 100.
                    return data;
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
                                return await createOneUser(user, userDoc._id, userDoc.email );
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
                                                                resolve(await createOneUser(mongoRecord.username, otherUser._id, otherUser.email ));
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

// Takes a single content reference id of type video or article and returns trimmed details
const fetchContentData = async (id) => {
    let session = driver.session();
    if (id.match(/(v|a)-([A-Za-z0-9-].*)/)) {
        let query = "";
        let validId = false;
        if (id.match(/(v|a)-([A-Za-z0-9-].*)/)[1] == "v") {
            query = "match (a:Video {mpd: $id}) return a";
            validId = true;
        } else if (id.match(/(v|a)-([A-Za-z0-9-].*)/)[1] == "a") {
            query = "match (a:Article {id: $id}) return a";
            validId = true;
        }
        if (validId == true) {
            id = id.match(/(v|a)-([A-Za-z0-9-].*)/)[2];
            let params = { id: id };
            let content = await session.run(query, params)
                .then(async (result) => {
                    session.close();
                    if (result) {
                        if (result) {
                            if (utility.get(result, 'records')) {
                                if (result.records[0]) {
                                    if (result.records[0]._fields) {
                                        if (result.records[0]._fields[0]) {
                                            if (result.records[0]._fields[0].properties) {
                                                if (result.records[0]._fields[0].properties.status != 'good') {
                                                    return null;
                                                }
                                                return result.records[0]._fields[0].properties;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        return null;
                    }
                });
            return content;
        }
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
            if (type == "article") {
                query = "match ( a:Article {id: $id}) return a";
            } else if (type == "AdVideo") {
                query = "match ( a:AdVideo {mpd: $id}) return a";
            }
            query = videoOrArticle(type, query);
            const nodeFound = await session.run(query, {id: id })
                .then(async (result) => {
                    session.close();
                    if (result.records) {
                        if (result.records.length > 0) { // If one video was found matching said username
                            return true;
                        } else {
                            return false;
                        }
                    }
                    return false;
                })
                .catch((err) => {
                    console.log(err);
                })
            return nodeFound;
        }
        return false;
    }
    return false;
}

/* Add one user to graph database */
const createOneUser = async (user, id, email = "") => {
    session = driver.session();
    query = "create (a:Person {name: $username, id: $id, avatarurl: '', email: $email }) return a";
    const userCreated = session.run(query, { username: user, id: id, email: email })
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
video.published = set to true externally when mongo record is not awaiting info or processing
video.status = will be bad, waiting;0, waiting;*timesincelastcheck* or good. This is whether or not nudity was found or not. 
video.nudity = this is whether or not the user has advised us that there is nudity or not. If nudity is found and status is bad, manually we must set video.status to "nudegood" to inform when videos are being filtered through that: "this video has nudity, but minipost has reviewed and allowed it to circulate in minipost recommendation system as a normal 'good' status video"
video.live = this is only present on ads. Videos are automatically circulating in recommendation system if status = good or nudegood, but for ads it requires an extra step. This step is to set live to true and create a redis history record. This record tracks clicks + impressions (views) each day. This is used to track if ad has surpassed daily budget.
*/
const createOneVideo = async (user, userUuid, mpd, title, description, nudity, tags, publishDate, responseTo, responseType, thumbnailUrl = null, advertisement = null, adData = null) => {
    if (user && mpd) {
        let videoCreateProcessComplete = checkUserExists(user)
        .then(async (result) => {
            if (!result) {
                return await createOneUser(user, userUuid);
            }
        })
        .then(async (result) => {
            if (advertisement) {
                return await checkNodeExists(mpd, "AdVideo");
            }
            return await checkNodeExists(mpd);
        })
        .then(async (result) => {
            let videoMongo = await Video.findOne({ _id: mpd }).lean();
            let videoPublished = false;
            // If mongo document is not in the format of "1603903019000;processing" or "1603903019000;awaitinginfo" then video is published
            if (videoMongo) {
                if (videoMongo.state) {
                    if (!videoMongo.state.match(/([0-9].*);([a-z].*)/)) {
                        videoPublished = true; // this should be true if the mongo record is not waiting for a title or is not waiting to be processed
                    }
                }
            }
            let session = driver.session();
            /* If result is null, create new video else update existing video in graph db */
            if (!result && videoMongo) {
                if (!description) {
                    description = "";
                }
                if (!tags) {
                    tags = "";
                }
                let query = "create (a:Video { mpd: $mpd, author: $user, authorUuid: $userUuid, title: $title, description: $description, nudity: $nudity, tags: $tags, views: 0, likes: 0, dislikes: 0, published: $videoPublished, thumbnailUrl: $thumbnailUrl, profanityJobId: '' }) return a";
                let params = { mpd: mpd, user: user, userUuid: userUuid, title: title, description: description, nudity: nudity, tags: tags, thumbnailUrl: thumbnailUrl, videoPublished: videoPublished };
                if (publishDate) { // The document can be created without a publishDate. If there is a publish date add it to params
                    params.publishDate = neo4j.int(publishDate);
                    query = "create (a:Video { mpd: $mpd, author: $user, authorUuid: $userUuid, title: $title, publishDate: $publishDate, description: $description, nudity: $nudity, tags: $tags, views: 0, likes: 0, dislikes: 0, published: $videoPublished, thumbnailUrl: $thumbnailUrl, profanityJobId: '' }) return a";
                }
                if (advertisement) {
                    query = "create (a:AdVideo { mpd: $mpd, author: $user, authorUuid: $userUuid, title: $title, description: $description, nudity: $nudity, tags: $tags, views: 0, published: $videoPublished, thumbnailUrl: $thumbnailUrl, profanityJobId: '', startDate: $startDate, endDate: $endDate, dailyBudget: $dailyBudget, adUrl: $adUrl, status: 'pending', clicks: 0 }) return a";
                    if (publishDate) { // The document can be created without a publishDate. If there is a publish date add it to params
                        query = "create (a:AdVideo { mpd: $mpd, author: $user, authorUuid: $userUuid, title: $title, publishDate: $publishDate, description: $description, nudity: $nudity, tags: $tags, views: 0, published: $videoPublished, thumbnailUrl: $thumbnailUrl, profanityJobId: '', startDate: $startDate, endDate: $endDate, dailyBudget: $dailyBudget, adUrl: $adUrl, status: 'pending', clicks: 0 }) return a";
                    }
                    params.startDate = null;
                    params.endDate = null;
                    params.dailyBudget = null;
                    params.adUrl = null;
                    if (adData) {
                        if (adData.startDate) {
                            params.startDate = adData.startDate;
                        }
                        if (adData.endDate) {
                            params.endDate = adData.endDate;
                        }
                        if (adData.dailyBudget) {
                            params.dailyBudget = adData.dailyBudget;    
                        }
                        if (adData.adUrl) {
                            params.adUrl = adData.adUrl;
                        }
                    }
                }
                const videoRecordCreated = await session.run(query, params)
                    .then(async (record) => {
                        session.close();
                        let session2 = driver.session();
                        // Will merge author node to just created video node in neo4j
                        query = "match (a:Person {name: $user}), (b:Video {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        if (advertisement) {
                            query = "match (a:Person {name: $user}), (b:AdVideo {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        }
                        session2.run(query, params);
                        return record;
                    })
                    .then(async (record) => {
                        if (responseTo && !advertisement) {
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
                    })
                return videoRecordCreated;
            } else {
                let query = "match (a:Video { mpd: $mpd }) set a += { ";
                if (advertisement) {
                    query = "match (a:AdVideo { mpd: $mpd }) set a += {";
                }
                let params = { mpd: mpd, author: user, userUuid: userUuid, title: title };
                if (publishDate) {
                    params.publishDate = neo4j.int(publishDate);
                }
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
                if (nudity == true) {
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
                addedOne++;
                if (videoMongo) {
                    if (videoPublished) {
                        addedOne > 0 ? query += ", " : null;
                        addedOne = 0;
                        query+= "published: true";
                        addedOne++;
                    }
                }
                params.startDate = null;
                params.endDate = null;
                params.dailyBudget = null;
                params.adUrl = null;
                if (advertisement && adData) {
                    params.startDate = adData.startDate;
                    params.endDate = adData.endDate;
                    params.dailyBudget = adData.dailyBudget;
                    params.adUrl = adData.adUrl;
                    addedOne > 0 ? query += ", " : null;
                    addedOne = 0;
                    query += "adUrl: $adUrl";
                    addedOne++;
                }
                if (advertisement && publishDate) {
                    query += " } with a where a.publishDate is null set a.publishDate = $publishDate with a where a.startDate is null set a.startDate = $startDate with a where a.endDate is null set a.endDate = $endDate with a where a.dailyBudget is null set a.dailyBudget = $dailyBudget return a"; // Cannot change publish date, start date, end date or daily budget
                } else if (advertisement) {
                    query += " } with a where a.startDate is null set a.startDate = $startDate with a where a.endDate is null set a.endDate = $endDate with a where a.dailyBudget is null set a.dailyBudget = $dailyBudget return a"; // Cannot change publish date, start date, end date or daily budget
                } else if (publishDate) {
                    query += " } with a where a.publishDate is null set a.publishDate = $publishDate return a"; // Cannot change publish date
                } else {
                    query += " } return a"; // Cannot change publish date
                }
                const videoRecordUpdated = await session.run(query, params)
                    .then(async (record) => {
                        let session2 = driver.session();
                        // Will merge author node to just created video node in neo4j
                        query = "match (a:Person {name: $user}), (b:Video {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        if (advertisement) {
                            query = "match (a:Person {name: $user}), (b:AdVideo {mpd: $mpd}) merge (a)-[r:PUBLISHED]->(b)";
                        }
                        session2.run(query, params);
                        return record;
                    })
                    .then(async (record) => {
                        if (responseTo && !advertisement) {
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
                    })
                    .catch((err) => {
                        console.log(err);
                    })
                return videoRecordUpdated;
            }
        })
        return videoCreateProcessComplete;
    }
}

/* Creates one article node on neo4j and merges user ((author)-[r:PUBLISHED]->(article)) to article neo4j node */
const createOneArticle = async (article, edit = false) => {
    try {
        if (article._id && article.author && article.title && article.body) {
            if (article._id.length > 0 && article.author.length > 0 && article.title.length > 0 && article.body.length > 0) {
                // Initial check to see if article with same id already exists
                let session = driver.session();
                let query = "match (a:Article { id: $id }) return a";
                let params = { id: article._id };
                let nodeExists = await session.run(query, params);
                if (!nodeExists || nodeExists.records.length == 0 && !edit) {
                    session.close();
                    let session2 = driver.session();
                    query = "match (a:Person { name: $author }) create (b:Article { id: $id, author: $author, title: $title, body: $body, publishDate: $publishDate, thumbnailUrl: $thumbnailUrl, reads: 0, likes: 0, dislikes: 0 }) merge (a)-[r:PUBLISHED]->(b) return b";
                    let thumbnailUrl = "";
                    if (article.thumbnailUrl) {
                        thumb = article.thumbnailUrl;
                    }
                    params = { id: article._id, author: article.author, title: article.title, body: article.body, publishDate: article.publishDate, thumbnailUrl: thumbnailUrl };
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
                } else if (nodeExists.records.length > 0) {
                    session.close();
                    let session2 = driver.session();
                    query = "match (a:Article { id: $id}) set a.title = $title, a.body = $body, a.thumbnailUrl = $thumbnailUrl return a";
                    let thumbnailUrl = "";
                    if (article.thumbnailUrl) {
                        thumbnailUrl = article.thumbnailUrl;
                    }
                    params = {id: article._id, title: article.title, body: article.body, thumbnailUrl: thumbnailUrl };
                    let updatedArticle = await session2.run(query, params);
                    if (updatedArticle) {
                        return true;
                    } else {
                        return false;
                    }
                }
            }
        }
        return false;
    } catch (err) {
        console.log(err);
        return false;
    }
}

/* Deletes one article from database. This should not be called often, it will not be called even if user deletes profile. Only call if error creating article on mongoDb to maintain consistency. Or if user wants to delete their own article */
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

/* Deletes one video from database. */
const deleteOneVideo = async (mpd, type = "Video") => {
    try {
        if (mpd) {
            if (mpd.length > 0) {
                let session = driver.session();
                let query = "match (a:Video { mpd: $mpd })-[r]-() WITH a, r, a.thumbnailUrl AS thumbnailUrl DELETE a, r RETURN thumbnailUrl";
                if (type == "AdVideo") {
                    query = "match (a:AdVideo { mpd: $mpd })-[r]-() WITH a, r, a.thumbnailUrl AS thumbnailUrl DELETE a, r RETURN thumbnailUrl";
                }
                let params = { mpd: mpd };
                let completeDeletion = await session.run(query, params);
                if (completeDeletion) {
                    session.close();
                    return completeDeletion;
                } else {
                    return false;
                }
            }
        }
        return false;
    } catch (err) {
        console.log(err);
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

const fetchSingleVideoData = async (mpd, user, ad = false) => {
    let session = driver.session();
    // Must query for original video and potential relational matches to articles. Not either/or or else query will not function properly
    let query = "match (a:Video {mpd: $mpd})-[:PUBLISHED]-(d:Person) optional match (a)-[r:RESPONSE]->(b) optional match (c)-[r2:RESPONSE]->(a) return a, r, b, c, d";
    if (ad) {
        query = "match (a:gAdVideo {mpd: $mpd})-[:PUBLISHED]-(d:Person) optional match (a)-[r:RESPONSE]->(b) optional match (c)-[r2:RESPONSE]->(a) return a, r, b, c, d";
    }
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
                views: "",
                viewable: false,
                avatarurl: ""
            }
            if (ad) {
                video.startDate = "";
                video.endDate = "";
                video.dailyBudget = "";
                video.adUrl = "";
                
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
                            if (result.records[0]._fields[0].properties.publishDate) {
                                if (result.records[0]._fields[0].properties.publishDate.toNumber) {
                                    video.published = result.records[0]._fields[0].properties.publishDate.toNumber();
                                } else {
                                    video.published = result.records[0]._fields[0].properties.publishDate;
                                }
                            }
                            if (result.records[0]._fields[0].properties.likes) {
                                if (result.records[0]._fields[0].properties.likes.toNumber) {
                                    video.likes = result.records[0]._fields[0].properties.likes.toNumber();
                                } else {
                                    video.likes = result.records[0]._fields[0].properties.likes;
                                }
                            }
                            if (result.records[0]._fields[0].properties.dislikes) {
                                if (video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber) {
                                    video.dislikes = result.records[0]._fields[0].properties.dislikes.toNumber();
                                } else {
                                    video.dislikes = result.records[0]._fields[0].properties.dislikes;
                                }
                            }
                            if (video.views = result.records[0]._fields[0].properties.views.toNumber) {
                                video.views = result.records[0]._fields[0].properties.views.toNumber();
                            } else {
                                video.views = result.records[0]._fields[0].properties.views;
                            }
                            if (result.records[0]._fields[0].properties.profanityJobId) {
                                if (result.records[0]._fields[0].properties.status == 'good') {
                                    video.viewable = true;
                                } else if (result.records[0]._fields[0].properties.status == 'waiting') {
                                    video.viewable = processprofanity.getProfanityData(result.records[0]._fields[0].properties.profanityJobId);
                                }
                            }
                            video.mpd = result.records[0]._fields[0].properties.mpd;
                            video.thumbnail = resolveEmptyData(result.records[0], "thumbnailUrl");
                            if (ad) {
                                if (result.records[0]._fields[0].properties.startDate && result.records[0]._fields[0].properties.endDate && result.records[0]._fields[0].properties.dailyBudget) {
                                    video.startDate = result.records[0]._fields[0].properties.startDate;
                                    video.endDate = result.records[0]._fields[0].properties.endDate;
                                    video.dailyBudget = result.records[0]._fields[0].properties.dailyBudget;
                                }
                                if (result.records[0]._fields[0].properties.adUrl) {
                                    video.adUrl = result.records[0]._fields[0].properties.adUrl;
                                }
                            }
                            // Append article and video responses of this video to articleResponses/videoResponses data member
                            for (let i = 0; i < result.records.length; i++) { // Only iterate through 3rd field (_fields[2]). That holds cypher variable b
                                if (result.records[i]) {
                                    if (result.records[i]._fields[2]) {
                                        if (result.records[i]._fields[2].properties) {
                                            if (result.records[i]._fields[2].labels[0] == "Article") {
                                                result.records[i]._fields[2].properties.likes = parseInt(result.records[i]._fields[2].properties.likes);
                                                result.records[i]._fields[2].properties.dislikes = parseInt(result.records[i]._fields[2].properties.dislikes);
                                                result.records[i]._fields[2].properties.reads = parseInt(result.records[i]._fields[2].properties.reads);
                                                data.articleResponses.push(result.records[i]._fields[2].properties);
                                            } else if (result.records[i]._fields[2].labels[0] == "Video" && result.records[i]._fields[2].properties.mpd != video.mpd || result.records[i]._fields[2].labels[0] == "gVideo" && result.records[i]._fields[2].properties.mpd != video.mpd) {
                                                if (result.records[i]._fields[2].properties.status != 'good' || !result.records[i]._fields[2].properties.status) {
                                                    result.records[i]._fields[2] = 'null';
                                                } else {
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
                        }
                        if (result.records[0]._fields[3]) { // Only look 4th field (_fields[3]) That holds cypher variable c. Parent document is responding to
                            if (result.records[0]._fields[3].properties) {
                                if (result.records[0]._fields[3].labels[0] == "Video" || result.records[0]._fields[3].labels[0] == "gVideo") {
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
                        if (result.records[0]._fields[4]) {
                            if (result.records[0]._fields[4].properties) {
                                if (result.records[0]._fields[4].properties.avatarurl) {
                                    video.avatarurl = result.records[0]._fields[4].properties.avatarurl;
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
                                if (result.records[0]._fields[3].labels[0] == "Video" || result.records[0]._fields[3].labels[0] == "gVideo") {
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
const setWatchReadRelationship = async (id, user, type = "video", ad = false) => {
    try {
        const d = new Date().getTime();
        let session = driver.session();
        let query = "match ( a:Person { name: $user }), ( b:Video { mpd: $mpd }) optional match (a)-[r:WATCHED]->(b) delete r merge (a)-[r2:WATCHED { time: $ms }]->(b) return a, r2, b";
        let params = { user: user, ms: neo4j.int(d), mpd: id };
        if (type == "article") {
            query = "match ( a:Person { name: $user }), ( b:Article { id: $id }) optional match (a)-[r:READ]->(b) delete r merge (a)-[r2:READ { time: $ms }]->(b) return a, r2, b";
            params = { user: user, ms: neo4j.int(d), id: id };
        }
        if (ad) {
            query = "match ( a:Person { name: $user }), ( b:AdVideo { mpd: $mpd }) optional match (a)-[r:WATCHED]->(b) delete r merge (a)-[r2:WATCHED { time: $ms }]->(b) return a, r2, b";
        }
        return await session.run(query, params);
    } catch (err) {
        return err;
    }
    return false;
}

// Will check for optional already existing WATCHED relationship and delete, then merge new WATCHED relationship with milliseconds since epoch (january 1, 1970)
const setClickedRelationship = async (id, user, type = "video", ad = false) => {
    try {
        const d = new Date().getTime();
        let session = driver.session();
        if (ad && type == "video" && id && user) {
            let query = "match ( a:Person { name: $user }), ( b:AdVideo { mpd: $mpd }) optional match (a)-[r:CLICKED]->(b) delete r merge (a)-[r2:CLICKED { time: $ms }]->(b) return a, r2, b";
            let params = { user: user, ms: neo4j.int(d), mpd: id };
            return await session.run(query, params);
        } else {
            return false;
        }
    } catch (err) {
        return err;
    }
    return false;
}

/** Experimental high frequency increment video views on redis database. Returns boolean
Accurate and reliable incrementation is maintained in redis, record values are simply copied to neo4j */
const incrementContentViewRead = async (id, user, type = "video", ad = false, adBudget = null, startDate = null, endDate = null) => {
    try {
        if (type == "video" || type == "article") {
            let marker = "views";
            if (type == "article") {
                marker = "reads";
            }
            let goodPlaylist;
            if (ad && adBudget && startDate && endDate) {
                goodPlaylist = await recommendations.incrementDailyBudgetRecord(id, "view", adBudget, startDate, endDate);
            }
            let contentExists;
            if (ad && type == "video") {
                contentExists = await checkNodeExists(id, "AdVideo");
            } else {
                contentExists = await checkNodeExists(id, type);
            }
            let waitForBudgetInc = false;
            if (ad) {
                waitForBudgetInc = true;
            }
            console.log(ad, contentExists, id, user, type);
            if (contentExists) {
                let contentExistsRedis;
                
                if (type == "video") {
                    contentExistsRedis = await videoviewsclient.hgetall(id, (err, value) => {
                        if (!err) {
                            return value;
                        } else {
                            return "failed, do not update";
                        }
                        return false;
                    });
                } else if (type == "article") {
                    contentExistsRedis = await articlereadsclient.hgetall(id, (err, value) => {
                        if (!err) {
                            return value;
                        } else {
                            return "failed, do not update";
                        }
                    })
                }
                console.log(contentExistsRedis);
                let promise = new Promise(async (resolve, reject) => {
                    setWatchReadRelationship(id, user, type, ad)
                        .then( async (result) => {
                            if (contentExistsRedis == "failed, do not update") {
                                reject(false);
                            } else if (contentExistsRedis) {
                                if (type == "video") {
                                    videoviewsclient.hincrby(id, marker, 1);
                                    return await videoviewsclient.hgetall(id, (err, value) => {
                                        console.log(value);
                                        if (ad) {
                                            setVideoViewsArticleReadsNeo(id, value.views, "video", ad);
                                        } else {
                                            setVideoViewsArticleReadsNeo(id, value.views, "video");
                                        }
                                        console.log("playlist good " + goodPlaylist);
                                        resolve({ 
                                            increment: true, 
                                            playlist: goodPlaylist
                                        });
                                    });
                                } else if (type == "article") {
                                    articlereadsclient.hincrby(id, marker, 1);
                                    return await articlereadsclient.hgetall(id, (err, value) => {
                                        console.log(value);
                                        setVideoViewsArticleReadsNeo(id, value.reads, "article");
                                        console.log("playlist good " + goodPlaylist);
                                        resolve({ 
                                            increment: true, 
                                            playlist: goodPlaylist
                                        });
                                    });
                                } else {
                                    resolve(false);
                                }
                            } else {
                                if (type == "video") {
                                    videoviewsclient.hmset(id, marker, 1, "likes", 0, "dislikes", 0);
                                    return await videoviewsclient.hgetall(id, (err, value) => {
                                        if (ad) {
                                            setVideoViewsArticleReadsNeo(id, value.views, "video", ad);
                                        } else {
                                            setVideoViewsArticleReadsNeo(id, value.views, "video");
                                        }
                                        resolve({ 
                                            increment: true, 
                                            playlist: goodPlaylist
                                        });
                                    });
                                } else if (type == "article") {
                                    articlereadsclient.hmset(id, marker, 1, "likes", 0, "dislikes", 0);
                                    return await articlereadsclient.hgetall(id, (err, value) => {
                                        setVideoViewsArticleReadsNeo(id, value.reads, "article");
                                        resolve({ 
                                            increment: true, 
                                            playlist: goodPlaylist
                                        });
                                    });
                                } else {
                                    resolve(false);
                                }
                            }
                    })
                    .catch((err) => {
                        console.log(err);
                        reject(err);
                    });
                });
                return promise.then((result) => {
                    return result;
                })
            } else {
                return false;
            }
        } else {
            return false;
        }
    } catch (err) {
        return false;
    }
    return false;
}

// Takes in array of semi-colon delimited value pairs like so [..., "046cd2f4-1f2b-4409-bcf8-cc17b0a2b67a;bliff", ...] and organizes subscribed list and notifications of subscribers
const getChannelNotifications = async (channels) => {
    try {
        let redisAccessible = true;
        let data = {
            subscribed: [

            ]
        };
        let promiseCheckAndReturnNotifications = channels.map(channel => {
            return new Promise( async (resolve, reject) => {
                if (channel.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)) {
                    if (channel.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[1] && channel.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[2]) {
                        let channelData = {
                            channel: channel.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[2],
                            notifications: []
                        }
                        return channelsubscriptionsclient.get(channel.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[1], (err, value) => {
                            if (err) {
                                redisAccessible = false;
                                return null;
                            }
                            if (JSON.parse(value) != null) {
                                channelData.notifications = JSON.parse(value);
                            }
                            data.subscribed.push(channelData);
                            resolve(JSON.parse(value));
                        });
                    } else {
                        return null;
                    }
                }
                reject(null);
            })
        });
        if (redisAccessible) {
            return await Promise.all(promiseCheckAndReturnNotifications).then((result) => {
                return data;
            })
        }
        return data;
    } catch (err) {
        console.log(err);
        return [];
    }
}

// Channel is user id. Data should be mpds or article ids.
const updateChannelNotifications = async(channel, data, type) => {
    try {
        if (type == "video") {
            data = "v-" + data;
        } else {
            data = "a-" + data;
        }
        // Value is the values returned by redis db and data is the new data to be appended to notifications
        const appendNotificationArr = (value, data) => {
            if (value.length) {
                if (value.length > 10) {
                    value = value.slice(0, 10); // Slice array if too long. Start index 0, end index 10. Notifications for individual account should only be 10 documents tops
                }
                value.map((x, i) => {
                    if (x == data) {
                        value.splice(i, 1); // Get rid of duplicates
                    }
                });
                value.push(data);
                return value;
            }
        }
        let redisAccessible = true;
        return new Promise( async (resolve, reject) => {
            return channelsubscriptionsclient.get(channel, (err, value) => {
                if (!value) { // If no channel subscriptions record for channel, create new to track channels newly created content
                    channelsubscriptionsclient.set(channel, JSON.stringify([data]));
                    return channelsubscriptionsclient.get(channel, (err, value) => {
                        if (err) {
                            reject(false);
                        }
                        if (value) {
                            value = JSON.parse(value);
                            value = appendNotificationArr(value, data);
                            channelsubscriptionsclient.set(channel, JSON.stringify(value));
                            resolve(true);
                        }
                    });
                } else {
                    value = JSON.parse(value);
                    value = appendNotificationArr(value, data);
                    channelsubscriptionsclient.set(channel, JSON.stringify(value));
                    resolve(true);
                }
            });
        });
    } catch (err) {
        // Something went wrong
        return false;
    }
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
        let nodeExists;
        let viewsOrReads = "views";
        let likeOrDislike = "likes";
        if (!like) {
            likeOrDislike = "dislikes";
        }
        nodeExists = await checkNodeExists(id, type.normalize().toLocaleLowerCase());
        if (type.normalize().toLocaleLowerCase() == "article") {
            viewsOrReads = "reads";
        }
        console.log(type, id, increment, like, user, cleanUp, nodeExists, viewsOrReads);
        if (nodeExists) {
            // Check if node exists in redis database
            let nodeExistsRedis = new Promise((resolve, reject) => {
                if (type.normalize().toLocaleLowerCase() == "article") {
                    articlereadsclient.hgetall(id, (err, value) => {
                        if (value) {
                            if (value.likes) {
                                if (value.likes < 0) {
                                    articlereadsclient.hmset(id, "likes", 0);
                                }
                            }
                            if (value.dislikes) {
                                if (value.dislikes < 0) {
                                    articlereadsclient.hmset(id, "dislikes", 0);
                                }
                            }
                        }
                        if (err) {
                            return reject("failed, do not update");
                        }
                        return resolve(value);
                    })
                } else {
                    videoviewsclient.hgetall(id, (err, value) => {
                        if (value) {
                            if (value.likes) {
                                if (value.likes < 0) {
                                    videoviewsclient.hmset(id, "likes", 0);
                                }
                            }
                            if (value.dislikes) {
                                if (value.dislikes < 0) {
                                    videoviewsclient.hmset(id, "dislikes", 0);
                                }
                            }
                        }
                        if (err) {
                            return reject("failed, do not update");
                        }
                        return resolve(value);
                    })
                }
            })
            // rediscontentclient.hgetall(id, (err, value) =>  will return created media of type
            return new Promise((resolve, reject) => {
                    nodeExistsRedis
                        .then( async (result) => {
                            console.log(result);
                            if (result == "failed, do not update") {
                                return resolve(false);
                            } else if (result) {
                                if (increment) {
                                    if (type.normalize().toLocaleLowerCase() == "article") {
                                        articlereadsclient.hincrby(id, likeOrDislike, 1);
                                        if (cleanUp) {
                                            articlereadsclient.hincrby(id, reverseLikeOrDislike(like), -1);
                                        }
                                    } else {
                                        videoviewsclient.hincrby(id, likeOrDislike, 1);
                                        if (cleanUp) {
                                            videoviewsclient.hincrby(id, reverseLikeOrDislike(like), -1);
                                        }
                                    }
                                } else {
                                    if (type.normalize().toLocaleLowerCase() == "article") {
                                        articlereadsclient.hincrby(id, likeOrDislike, -1);
                                    } else {
                                        videoviewsclient.hincrby(id, likeOrDislike, -1);
                                    }
                                }
                                if (type.normalize().toLocaleLowerCase() == "article") {
                                    articlereadsclient.hgetall(id, (err, value) => {
                                        if (err) {
                                            return resolve(false);
                                        }
                                        return resolve(value);
                                    });
                                } else {
                                    videoviewsclient.hgetall(id, (err, value) => {
                                        if (err) {
                                            return resolve(false);
                                        }
                                        return resolve(value);
                                    });
                                }
                            } else {
                                if (increment) {
                                    if (like) {
                                        if (type.normalize().toLocaleLowerCase() == "article") {
                                            articlereadsclient.hmset(id, viewsOrReads, 1, "likes", 1, "dislikes", 0);
                                        } else {
                                            videoviewsclient.hmset(id, viewsOrReads, 1, "likes", 1, "dislikes", 0);
                                        }
                                    } else {
                                        if (type.normalize().toLocaleLowerCase() == "article") {
                                            articlereadsclient.hmset(id, viewsOrReads, 1, "likes", 0, "dislikes", 1);
                                        } else {
                                            videoviewsclient.hmset(id, viewsOrReads, 1, "likes", 0, "dislikes", 1);
                                        }
                                    }
                                    if (type.normalize().toLocaleLowerCase() == "article") {
                                        articlereadsclient.hgetall(id, (err, value) => {
                                            if (err) {
                                                return resolve(false);
                                            }
                                            return resolve(value);
                                        });
                                    } else {
                                        videoviewsclient.hgetall(id, (err, value) => {
                                            if (err) {
                                                return resolve(false);
                                            }
                                            return resolve(value);
                                        });
                                    }
                                }
                            }
                        })
                        .catch((err) => {
                            console.log(err);
                            if (err) {
                                return resolve(false);
                            }
                            return resolve(true);
                        })
            });
        } else {
            return false;
        }
    } catch (err) {
        return false;
    }
}

/** Sets video views by passed value. Is not incremental which can cause inaccuracy on neo4j. Inconsequential if fails or not working well, can replace with method that
updates all neo4j video records on schedule. Views are reliably incremented with redis */
const setVideoViewsArticleReadsNeo = async (id, value, type = "video", ad = false) => {
    try {
        if (parseInt(value)) {
            let session = driver.session();
            let query = "match (a:Video {mpd: $mpd}) set a.views = $views return a";
            if (type == "video" && ad) {
                query = "match (a:gAdVideo {mpd: $mpd}) set a.views = $views return a";
            }
            let params = { mpd: id, views: neo4j.int(value) };
            if (type == "article") {
                query = "match (a:Article {id: $id}) set a.reads = $reads return a";
                params = { id: id, reads: neo4j.int(value) };
            }
            return await session.run(query, params)
                .then((result) => {
                    session.close();
                    if (result) {
                        return true;
                    } else {
                        return false;
                    }
                })
                .catch((err) => {
                    console.log(err);
                })
        } else {
            return false;
        }
    } catch (err) {
        return false;
    }
}

// When concatting two arrays of media together, check to see if duplicates are present before merging. Used for appending more videos to client dash
const removeDuplicates = async (media) => {
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
                                                    if (media[i]._fields[0].properties.responses.length < media[j]._fields[0].properties.responses.length) {
                                                        media[i]._fields[0].responses.articles = [...media[j]._fields[0].responses.articles];
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
                    } else {
                        for (let j = 0; j < media.length; j++) {
                            if (media[j]) {
                                if (media[j]._fields) {
                                    if (media[j]._fields[0]) {
                                        if (utility.get(media[j]._fields[0], 'properties.id')) {
                                            if (media[i]._fields[0].properties.id == media[j]._fields[0].properties.id) {
                                                if (found > 0) {
                                                    // Cycles to check if any articles were missed by appending duplicate record with higher article response count
                                                    if (media[i]._fields[0].properties.responses.length < media[j]._fields[0].properties.responses.length) {
                                                        media[i]._fields[0].properties.responses = [...media[j]._fields[0].responses.articles];
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
    return media;
}

const videoOrArticle = (type, query) => {
    if (type) {
        if (type.normalize().toLocaleLowerCase() === "article") {
            query = query.replace(":Video", ":Article");
            query = query.replace("mpd:", "id:");
        }
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
        return false;
    }
    return false;
}

const setContentData = async (values, type, id) => {
    try {
        let viewsOrReads = "views";
        let session = driver.session();
        let query = "match (a:Video {mpd: $id}) set ";
        let params = { id: id };
        if (type.normalize().toLocaleLowerCase() == "article") {
            viewsOrReads = "reads";
            query = "match (a:Article {id: $id}) set ";
        }
        if (values.likes && values.dislikes) {
            query += "a.likes = $likes, a.dislikes = $dislikes";
            params.likes = neo4j.int(values.likes);
            params.dislikes = neo4j.int(values.dislikes);
        } else if (values.likes) {
            query += "a.likes = $likes";
            params.likes = neo4j.int(values.likes);
        } else {
            query += "a.dislikes = $dislikes";
            params.dislikes = neo4j.int(values.dislikes);
        }
        if (values.views) {
            query += ", a.views = $views";
            params.views = neo4j.int(values.views);
        }
        if (values.reads) {
            query += ", a.reads = $reads";
            params.reads = neo4j.int(values.reads);
        }
        query += " return a";
        return await session.run(query, params)
            .then((result) => {
                session.close();
            return true;
        })
    } catch (err) {
        console.log(err);
        return false;
    }
}

// Fetches data for single profile page
const fetchProfilePageData = async (user, self) => {
    try {
        if (user) {
            if (user.length > 0) {
                let session = driver.session();
                let query = "match (a:Person { name: $user }) optional match (a)-[r:PUBLISHED]-(b) return a, b";
                let params = { user: user };
                return await session.run(query, params)
                    .then( async (result) => {
                        // Will check videos to see if profanity jobs are complete
                        result.records = await contentutility.removeBadVideos(result.records, 1, self);
                        return result;
                    }).then( async (result) => {
                        let data = {
                            user: {},
                            content: [],
                            totalviews: 0,
                            totalreads: 0,
                            totalvideos: 0,
                            totalarticles: 0,
                            cloud: s3Cred.cdn.cloudFront1
                        }
                        let userObject = {
                            username: "",
                            id: ""
                        }
                        if (result.records) {
                            if (result.records.length > 0) {
                                if (result.records[0]._fields) {
                                    if (result.records[0]._fields[0]) {
                                        if (result.records[0]._fields[0].properties) {
                                            userObject.username = result.records[0]._fields[0].properties.name;
                                            userObject.id = result.records[0]._fields[0].properties.id;
                                            if (result.records[0]._fields[0].properties.avatarurl) {
                                                userObject.avatarurl = result.records[0]._fields[0].properties.avatarurl;
                                            }
                                        }
                                    }
                                }
                                data.user = userObject;
                                for (const record of result.records) {
                                    if (record._fields) {
                                        if (record._fields[1]) {
                                            if (record._fields[1].labels) {
                                                if (record._fields[1].labels[0]) {
                                                    record._fields[1].labels.forEach((label) => {
                                                        if (record._fields[1].properties) {
                                                            let add = false;
                                                            if (label == "Article") {
                                                                data.totalarticles++;
                                                                if (record._fields[1].properties.reads) {
                                                                    record._fields[1].properties.reads = parseInt(record._fields[1].properties.reads);
                                                                    data.totalreads += parseInt(record._fields[1].properties.reads);
                                                                    add = true;
                                                                }
                                                            } else if (label == "Video") {
                                                                data.totalvideos++;
                                                                if (record._fields[1].properties.views) {
                                                                    record._fields[1].properties.views = parseInt(record._fields[1].properties.views);
                                                                    data.totalviews += parseInt(record._fields[1].properties.views);
                                                                    add = true;
                                                                }
                                                            } else if (label == "AdVideo") {
                                                                record._fields[1].properties.views = parseInt(record._fields[1].properties.views);
                                                                record._fields[1].properties.clicks = parseInt(record._fields[1].properties.clicks);
                                                                add = true;
                                                            }
                                                            if (add) {
                                                                if (record._fields[1].properties.publishDate) {
                                                                    if (record._fields[1].properties.publishDate.toNumber) {
                                                                        record._fields[1].properties.publishDate = record._fields[1].properties.publishDate.toNumber();
                                                                    }
                                                                }
                                                                if (!record._fields[1].properties.title) {
                                                                    record._fields[1].properties.title = '';
                                                                }
                                                                if (record._fields[1].properties.status) {
                                                                    if (record._fields[1].properties.status != 'good') {
                                                                        record._fields[1].properties.thumbnailUrl = '';
                                                                    }
                                                                } else {
                                                                    record._fields[1].properties.thumbnailUrl = '';
                                                                }
                                                                record._fields[1].properties.likes = parseInt(record._fields[1].properties.likes);
                                                                record._fields[1].properties.dislikes = parseInt(record._fields[1].properties.dislikes);
                                                                data.content.push(record._fields[1].properties);
                                                            }
                                                        }
                                                    })
                                                }
                                            }
                                        }
                                    }
                                }
                                return data;
                            }
                        }
                        return false;
                    })
                    .catch((err) => {
                        return false;
                    })
            }
        }
    } catch (err) {
        return false;
    }
}

// Return channels user is following
const getFollows = async (user) => {
    try {
        if (user) {
            let session = driver.session();
            let query = "match (a:Person { name: $user })-[r:FOLLOWS]->(b:Person) return a, r, b";
            let params = { user: user };
            return await session.run(query, params)
                .then((result) => {
                    let channels = [];
                    if (checkGoodResultsCeremony(result.records)) {
                        // Map through results and return ids of all channels to return data
                        result.records.map(record =>
                            record._fields ?
                                record._fields[2] ?
                                    record._fields[2].properties.id && record._fields[2].properties.name ?
                                        channels.push(record._fields[2].properties.id + ";" + record._fields[2].properties.name)
                                    : null
                                : null
                            : null
                        );
                    }
                    return channels;
                })
                .catch((err) => {
                    console.log(err);
                    return [];
                })
        }
    } catch (err) {
        // Something went wrong
        return [];
    }
    return [];
}

// Set following relationship for user to one channel, either subscribe or unsubscribe
const setFollows = async (user, channel, subscribe) => {
    try {
        if (user && channel) {
            let session = driver.session();
            let query = "match (a:Person { name: $user }), (c:Person { name: $channel }) optional match (a)-[r:FOLLOWS]->(b:Person)";
            // The value of subscribe (boolean) is coming in as a string sometimes, dont worry about it. Yeah I know. It works
            if (subscribe == "true") {
                subscribe = true;
            } else if (subscribe == "false") {
                subscribe = false;
            }
            if (subscribe == true) {
                query += " merge (a)-[:FOLLOWS]->(c) return a, r, b, c";
            } else {
                query += ", (a)-[r2:FOLLOWS]->(c) delete r2 return a, r, b, c";
            }
            let params = { user: user, channel: channel };
            return await session.run(query, params)
                .then((result) => {
                    let channels = [];
                    if (checkGoodResultsCeremony(result.records)) {
                        // Map through results and return ids of all channels to return data
                        result.records.map(record =>
                            record._fields ?
                                record._fields[2] ?
                                    record._fields[2].properties.id && record._fields[2].properties.name ?
                                        channels.push(record._fields[2].properties.id + ";" + record._fields[2].properties.name)
                                    : null
                                : null
                            : null
                        );
                        // Add user just followed to list of channels to return
                        if (result.records[0]._fields[3] && subscribe == true) {
                            if (get(result.records[0]._fields[3], 'properties.id') && get(result.records[0]._fields[3], 'properties.name')) {
                                if (channels.indexOf(result.records[0]._fields[3].properties.id + ";" + result.records[0]._fields[3].properties.name) < 0) {
                                    channels.push(result.records[0]._fields[3].properties.id + ";" + result.records[0]._fields[3].properties.name);
                                }
                            }
                        }
                    }
                console.log(channels);
                    return channels;
                })
                .catch((err) => {
                    console.log(err);
                    return [];
                })
        }
    } catch (err) {
        // Something went wrong
        return [];
    }
    return [];
}

const checkGoodResultsCeremony = (records) => {
    if (records) {
        if (records.length > 0) {
            if (records[0]._fields) {
                if (records[0]._fields[0]) {
                    if (records[0]._fields[0].properties) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

// Sets profanity check job id reference on a created record
const setProfanityCheck = (uuid, job, status, type = "Video") => {
    let session = driver.session();
    let nodeExists = checkNodeExists(uuid, type);
    if (uuid && job && nodeExists && !status) {
        let query = "match (a:Video { mpd: $uuid}) set a += { profanityJobId: $profanityJobId, status: 'waiting;0' } return a";
        if (type == "AdVideo") {
            query = "match (a:AdVideo { mpd: $uuid}) set a += { profanityJobId: $profanityJobId, status: 'waiting;0' } return a";
        }
        let params = { uuid: uuid, profanityJobId: job };
        return session.run(query, params)
            .then((record) => {
                return record;
            });
    } else {
        return null;
    }
}

// Return type can be the record or false
const setUserThumbnail = async (user, location) => {
    if (user) {
        let session = driver.session();
        let userExists = await checkUserExists(user);
        if (location && userExists) {
            let query = "match (a:Person { name: $user }) with a, a {.*} as snapshot set a.avatarurl = $location return a, snapshot";
            let params = { user: user, location: location };
            return session.run(query, params)
                .then( async (record) => {
                    if (record.records) {
                        if (record.records[0]) {
                            if (record.records[0]._fields) {
                                if (record.records[0]._fields[1]) {
                                    if (record.records[0]._fields[1].avatarurl) { // Should be the snapshot of the user old before avatar updated. Delete old avatar img from s3.
                                        let data = await deleteFromS3("av/" + record.records[0]._fields[1].avatarurl, "minifs-avatar");
                                        if (data && record.records[0]._fields[0]) {
                                            if (record.records[0]._fields[0].properties) {
                                                return record.records[0]._fields[0].properties;
                                            }
                                            return record;
                                        } else {
                                            return record;
                                        }
                                    } else {
                                        if (record.records[0]._fields[0]) {
                                            if (record.records[0]._fields[0].properties) {
                                                return record.records[0]._fields[0].properties;
                                            }
                                        }
                                        return record;
                                    }
                                } else {
                                    return record;
                                }
                            } else {
                                return record;
                            }
                        } else {
                            return record;
                        }
                    } else {
                        return record;
                    }
                })
                .then((record) => {
                    return record;
                })
                .catch((err) => {
                    return false;
                })
        } else {
            return false;
        }
    } else {
        return false;
    }
}

const deleteFromS3 = async (key, bucket) => {
    let params = {
        Bucket: bucket,
        Key: key
    };
    let promise = new Promise((resolve, reject) => {
        s3.deleteObject(params, function(err, data) {
            if (err) {
                reject('error deleting s3 object');
            } else {
                resolve('deleted s3 object successfully');
            }                 
        });            
    });
    return promise;
}

const fetchOneUser = async (user) => {
    if (user) {
        let session = driver.session();
        let query = "match (a:Person { name: $user }) return a";
        let params = { user: user };
        return session.run(query, params)
            .then((result) => {
                if (result.records) {
                    if (result.records[0]) {
                        if (result.records[0]._fields) {
                            if (result.records[0]._fields[0]) {
                                if (result.records[0]._fields[0].properties) {
                                    return result.records[0]._fields[0].properties;
                                }
                            }
                        }
                    }
                }
                return false;
            })
            .catch((err) => {
                return false;
            })
    } else {
        return false;
    }
}

const incrementContentClick = async (id, user, type = "video", ad, adBudget, startDate, endDate) => {
    try {
        if (user) {
            console.log(id, user, ad, adBudget, startDate, endDate);
            let contentExists;
            if (ad && adBudget && startDate && endDate) {
                contentExists = await checkNodeExists(id, "AdVideo");
                if (contentExists) {
                    let goodPlaylist = await recommendations.incrementDailyBudgetRecord(id, "click", adBudget, startDate, endDate);
                    let setClickedRel = await setClickedRelationship(id, user, type, ad);
                    return { 
                        increment: true, 
                        playlist: goodPlaylist 
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

module.exports = {
    checkFriends: checkFriends,
    serveVideoRecommendations: serveVideoRecommendations,
    createOneVideo: createOneVideo,
    createOneArticle: createOneArticle,
    deleteOneArticle: deleteOneArticle,
    deleteOneVideo: deleteOneVideo,
    fetchSingleVideoData: fetchSingleVideoData,
    fetchSingleArticleData: fetchSingleArticleData,
    incrementContentViewRead: incrementContentViewRead,
    createOneUser: createOneUser,
    fetchOneUser: fetchOneUser,
    incrementLike: incrementLike,
    fetchProfilePageData: fetchProfilePageData,
    setFollows: setFollows,
    getFollows: getFollows,
    getChannelNotifications: getChannelNotifications,
    updateChannelNotifications: updateChannelNotifications,
    fetchContentData: fetchContentData,
    setProfanityCheck: setProfanityCheck,
    setUserThumbnail: setUserThumbnail,
    incrementContentClick: incrementContentClick
};
