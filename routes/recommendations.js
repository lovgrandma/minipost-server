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
                            if (field == "goodVideos") {
                                exists.videos = true;
                            } else if (field == "articles") {
                                exists.articles = true;
                            }
                        })
                    }
                })
                if (exists.videos == false) {
                    let session2 = driver.session();
                    let query = "CALL db.index.fulltext.createNodeIndex(\"goodVideos\",[\"gVideo\"],[\"title\", \"description\", \"author\", \"tags\", \"mpd\", \"thumbnailUrl\", \"views\", \"publishDate\"])";
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
                    query = "CALL db.index.fulltext.queryNodes(\"goodVideos\", \"" + value + "\") YIELD node, score RETURN node.title, node.description, node.author, node.tags, node.mpd, node.thumbnailUrl, node.views, node.publishDate, score";
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

const getRelatedContent = async (id, type, paginate, title) => {
    let content = [];
    try {
        // Attempt to get highest numbers of (b) videos with a:video - watched - user - watched - b:video relationship.
        // Plain english: Return most likely videos for user to watch if they've watched this video (Related). Should function with articles too
        return getHighestRelatedOnContent(id, type, paginate).then( async (data) => {
            return data;
        });
    } catch (err) {
        console.log(err);
    }
    // If result is less than 10, make a simple fulltext search using "getSearchResults" method in this file
    
    // Return array regardless if 0 or more. Continually update paginate to paginate content properly
}

// Gets highest related to single video or article. Sufficient enough for single video/article page related queries. No other queries are necessary
const getHighestRelatedOnContent = async (id, type, paginate) => {
    let session = driver.session();
    let query = 'match ( a:Video { mpd: $id })-[:WATCHED]-(:Person)-[:WATCHED]-(b:gVideo) return b, count(b) as total limit $paginate union match ( a:Video { mpd: $id })-[:WATCHED]-(:Person)-[:READ]-(b:Article) return b, count(b) as total limit $paghalf ';
    let params = { id: id, paginate: neo4j.int(paginate), paghalf: neo4j.int(paginate/3) };
    if (type == 'article') {
        query = 'match ( a:Article { id: $id })-[:READ]-(:Person)-[:READ]-(b:Article) return b, count(b) as total limit $paginate union match (a:Article { id: $id })-[:READ]-(:Person)-[:WATCHED]-(b:gVideo) return b, count(b) as total limit $paginate';
        params.paghalf = neo4j.int(paginate);
    }
    // paghalf is used to refer less articles as a limit to show more videos
    let data = await session.run(query, params);
    for (let i = 0; i < data.records.length; i++) {
        data.records[i]._fields[1] = neo4j.integer.toNumber(data.records[i]._fields[1]);
        if (data.records[i]._fields[0].properties.reads) {
            if (data.records[i]._fields[0].properties.reads.low) {
                data.records[i]._fields[0].properties.reads = data.records[i]._fields[0].properties.reads.low;
            }
        }
        if (data.records[i]._fields[0].properties.publishDate) {
            if (data.records[i]._fields[0].properties.publishDate.toNumber) {
                data.records[i]._fields[0].properties.publishDate = data.records[i]._fields[0].properties.publishDate.toNumber();
            }
        }
    }
    return data;
}

const getRelevantPlaylist = async (user, append) => {
    try {
        let session = driver.session();
        // Get playlist for videos user would likely want to watch: a:videos user watched -> r:watched recently (top 100) relationship -> other users -> r2:watched recently (top 100) -> c:videos they watched 
        // let query = "match (a:Person { name: $user })-[r:WATCHED]-(b:Video)-[r2:WATCHED]-(c:Person)-[r3:WATCHED]-(d:gVideo) with d, r order by r.ms return distinct d limit 100" // 
        // Experiemental query to return recommended videos based on last watched recently in which recommended != videos recently watched
        let query = "match (a:Video)-[r:WATCHED]-(b:Person) with a, r, b order by a.views limit 100 match (b)-[r2:WATCHED]-(c:gVideo) with a, b, r2, c order by r2.ms limit 100 where not a.mpd = c.mpd return distinct c limit 100";
        if (user) {
            query = "match (a:Person { name: $user })-[r:WATCHED]-(b:Video) with r, b order by r.ms limit 50 match (b)-[r2:WATCHED]-(c:Person) with b, r2, c order by r2.ms limit 100 match (c)-[r3:WATCHED]-(d:gVideo) with d, r3, b order by r3.ms where not b.mpd = d.mpd return distinct d limit 100";
        }
        let params = { user: user };
        return await session.run(query, params)
            .then((result) => {
                session.close();
                result.records.forEach((record) => {
                    if (record._fields) {
                        if (record._fields[0]) {
                            if (record._fields[0].properties) {
                                if (record._fields[0].properties.likes) {
                                    if (record._fields[0].properties.likes.toNumber) {
                                        record._fields[0].properties.likes = record._fields[0].properties.likes.toNumber();
                                    }
                                }
                                if (record._fields[0].properties.dislikes) {
                                    if (record._fields[0].properties.dislikes.toNumber) {
                                        record._fields[0].properties.dislikes = record._fields[0].properties.dislikes.toNumber();
                                    }
                                }
                                if (record._fields[0].properties.views) {
                                    if (record._fields[0].properties.views.toNumber) {
                                        record._fields[0].properties.views = record._fields[0].properties.views.toNumber();
                                    }
                                }
                            }
                        }
                    }
                })
                if (result.records.length == 0) {
                    return 'defer';
                } else {
                    return result.records;
                }
            });
        return [];
    } catch (err) {
        console.log(err);
        return [];
    }
}

// Will return 10 ads in circulation best suited for user based on watch history
const getRelevantAds = async (user) => {
    try {
        let session = driver.session();
        let query = 'match (a:Video)-[r:WATCHED]-(b:Person) with a, r, b order by a.views limit 100 match (b)-[r2:CLICKED]-(c:gAdVideo) where c.live = \'true\' with a, b, r2, c order by r2.clicks return distinct c limit 10';
        if (user) {
            query = 'match (a:Person { name: $user })-[r:WATCHED]-(b:Video) with r, b order by r.ms limit 50 match (b)-[r2:WATCHED]-(c:Person) with b, r2, c order by r2.ms limit 100 match (c)-[r3:CLICKED]-(d:gAdVideo) where d.live = \'true\' with c, r3, d order by d.clicks return distinct d limit 10';
        }
        let params = { user: user };
        return await session.run(query, params)
            .then( async (result) => {
                session.close();
                result.records.forEach((record) => {
                    console.log(record._fields[0].properties.title);
                    if (record._fields) {
                        if (record._fields[0]) {
                            if (record._fields[0].properties) {
                                if (record._fields[0].properties.views) {
                                    if (record._fields[0].properties.views.toNumber) {
                                        record._fields[0].properties.views = record._fields[0].properties.views.toNumber();
                                    }
                                }
                                if (record._fields[0].properties.clicks) {
                                    if (record._fields[0].properties.clicks.toNumber) {
                                        record._fields[0].properties.clicks = record._fields[0].properties.clicks.toNumber();
                                    }
                                }
                                if (record._fields[0].properties.publishDate) {
                                    if (record._fields[0].properties.publishDate.toNumber) {
                                        record._fields[0].properties.publishDate = record._fields[0].properties.publishDate.toNumber();
                                    }
                                }
                            }
                        }
                    }
                });
                if (result.records.length < 10) { // run again, get generic ads. User has no history or no clicks on ads to query. Recommend all live ads. Can recommend by least impressions conditionally. Show recommended ad, then show low interaction ad, alternate to ensure ads are getting play time
                    let session2 = driver.session();
                    query = 'match (a:gAdVideo) where a.live = \'true\' return distinct a limit 100';
                    let genericAds = await session2.run(query);
                    genericAds.records.forEach((record) => {
                        console.log(record._fields[0].properties.title);
                        if (record._fields) {
                            if (record._fields[0]) {
                                if (record._fields[0].properties) {
                                    if (record._fields[0].properties.views) {
                                        if (record._fields[0].properties.views.toNumber) {
                                            record._fields[0].properties.views = record._fields[0].properties.views.toNumber();
                                        }
                                    }
                                    if (record._fields[0].properties.clicks) {
                                        if (record._fields[0].properties.clicks.toNumber) {
                                            record._fields[0].properties.clicks = record._fields[0].properties.clicks.toNumber();
                                        }
                                    }
                                    if (record._fields[0].properties.publishDate) {
                                        if (record._fields[0].properties.publishDate.toNumber) {
                                            record._fields[0].properties.publishDate = record._fields[0].properties.publishDate.toNumber();
                                        }
                                    }
                                }
                            }
                        }
                    });
                    // For each record make sure to check redis if ads have hit their limits. If ads hit their daily limit, exclude 

                    result.records = result.records.concat(genericAds.records);
                    return await checkValidAds(result.records);
                } else {
                    return await checkValidAds(result.records);
                }
            })
        return [];
    } catch (err) {
        console.log(err);
        return [];
    }
}

// Daily budget string hashes follow this format 00/00/0000 : views;clicks;dailyBudget;dailyCurrentTotal;startDate;endDate
// This will ingest ad records to be sent to the user. Determine if they have hit their daily limits and spit out ads that are still under their $$$ limit
const checkValidAds = async(records = []) => {
    let getSingleRecord = async (record) => {
        return await new Promise(async (resolve, reject) => {
            dailyadlimitsclient.hgetall(record._fields[0].properties.mpd, (err, value) => { // check to see if document exists
                if (!err) {
                    resolve(value);
                }
                reject("failed, do not update");
            });
        })
    };
    let getDailyBudgetAll = records.map(record => {
        return new Promise(async (resolve, reject) => {
            if (record._fields) {
                if (record._fields[0]) {
                    if (record._fields[0].properties) {
                        if (record._fields[0].properties.mpd && record._fields[0].properties.dailyBudget && record._fields[0].properties.startDate && record._fields[0].properties.endDate) {
                            let redisRecord = await getSingleRecord(record);
                            if (redisRecord == "failed, do not update") {
                                reject(null);
                            } else {
                                try {
                                    if (redisRecord) {
                                        // run method to get current days in the month to cycle through each day in month
                                        let currentMonth = new Date().getMonth() + 1;
                                        let currentYear = new Date().getFullYear();
                                        let currentDate = new Date().getDate();
                                        // Now we can check if we are within the timeline of the ads campaign time
                                        let startDate = new Date(parseInt(record._fields[0].properties.startDate)).getTime();
                                        let endDate = new Date(parseInt(record._fields[0].properties.endDate)).getTime();
                                        let now = new Date();
                                        now.setHours(24); // This signifies that ad will run at start of startDate and before the endDate begins.
                                        now = now.getTime();
                                        if (now > startDate && now < endDate) { // This confirms we are within the time of the ad campaign. Lets see if the daily budget has been hit
                                            let matchClicks = currentMonth + "/" + currentDate + "/" + currentYear + "-c";
                                            let matchViews = currentMonth + "/" + currentDate + "/" + currentYear + "-v";
                                            let clicks = 0;
                                            let views = 0;
                                            Object.keys(redisRecord).map(key => {
                                                console.log(redisRecord);
                                                if (key == matchClicks) {
                                                    clicks = redisRecord[key];
                                                }
                                                if (key == matchViews) {
                                                    views = redisRecord[key];
                                                }
                                            })
                                            let dailyBudget = record._fields[0].properties.dailyBudget;
                                            let daysCostOfViews = parseInt(views) * 0.03; // USD
                                            let daysCostOfClicks = parseInt(clicks) * 0.15; // USD
                                            let currentDailyCost = daysCostOfClicks + daysCostOfViews;
                                            console.log(views, clicks, currentDailyCost, dailyBudget);
                                            if (currentDailyCost < dailyBudget) { // if the ad is under the budget for the day, return the ad to the user to watch
                                                resolve(record);
                                            } else {
                                                resolve(null);
                                            }
                                        } else {
                                            resolve(null);
                                        }
                                        resolve(record);
                                    } else {
                                        let date = new Date();
                                        let formattedDate = (date.getMonth() + 1) + "/" + date.getDate() + "/" + date.getFullYear();
                                        dailyadlimitsclient.hmset(record._fields[0].properties.mpd, formattedDate + "-c", 0, formattedDate + "-v", 0);
                                        resolve(record);
                                    }
                                } catch (err) {
                                    console.log(err);
                                    resolve(null);
                                }
                            }
                        } else {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }                                  
        });
    });
    records = await Promise.all(getDailyBudgetAll);
    for (let i = 0; i < records.length; i++) {
        if (!records[i]) {
            records.splice(i, 1);
            i--;
        }
    }
    return records;
}

const getDaysInMonth = function(month, year) {
    return new Date(year, month, 0).getDate();
}

// Only runs for ads
const incrementDailyBudgetRecord = async(id, type = "view", adBudget, startDate, endDate) => {
    try {
        let contentExists;
        let redisAccessible = await new Promise(async (resolve, reject) => {
            dailyadlimitsclient.hgetall(id, (err, value) => { // check to see if document exists
                if (!err) {
                    contentExists = value;
                } else {
                    reject(false);
                }
                resolve(true);
            });  
        });
        if (redisAccessible) {
            if (adBudget && startDate && endDate) {
                startDate = new Date(parseInt(startDate)).getTime();
                endDate = new Date(parseInt(endDate)).getTime();
                if (type == "view") {
                    let incView = new Promise((resolve, reject) => {
                        let date = new Date();
                        let formattedDate = (date.getMonth() + 1) + "/" + date.getDate() + "/" + date.getFullYear();
                        if (contentExists) {
                            dailyadlimitsclient.hincrby(id, formattedDate + "-v", 1);
                            dailyadlimitsclient.hgetall(id, (err, value) => {
                                if (err) {
                                    resolve(false);
                                }
                                let clicks = 0;
                                let views = 0;
                                let impressions = 0;
                                console.log(value);
                                Object.keys(value).map(key => {
                                    if (key == formattedDate + "-c") {
                                        clicks = value[key];
                                    }
                                    if (key == formattedDate + "-v") {
                                        views = value[key];
                                    }
                                    if (key == formattedDate + "-i") {
                                        impressions = value[key];
                                    }
                                })
                                let daysCostOfViews = parseInt(views) * 0.03; // USD
                                let daysCostOfClicks = parseInt(clicks) * 0.15; // USD
                                let daysCostOfImpressions = parseInt(impressions) * 0.0018; // USD
                                let currentDailyCost = daysCostOfClicks + daysCostOfViews + daysCostOfImpressions;
                                console.log(views, clicks, currentDailyCost, adBudget);
                                if (currentDailyCost < adBudget) { // if the ad is under the budget for the day, video is good
                                    resolve(true);
                                } else {
                                    resolve(false); // user must request new playlist
                                }
                            });
                        } else {
                            try {
                            dailyadlimitsclient.hmset(id, formattedDate + "-c", 0, formattedDate + "-v", 1);
                                resolve(true);
                            } catch (err) {
                                reject(false);
                            }
                        }
                    });
                    return incView.then((result) => {
                        console.log(result);
                        return result;
                    })
                } else if (type == "click") {
                    let incView = new Promise((resolve, reject) => {
                        let date = new Date();
                        let formattedDate = (date.getMonth() + 1) + "/" + date.getDate() + "/" + date.getFullYear();
                        if (contentExists) {
                            dailyadlimitsclient.hincrby(id, formattedDate + "-c", 1);
                            dailyadlimitsclient.hgetall(id, (err, value) => {
                                if (err) {
                                    resolve(false);
                                }
                                let clicks = 0; // if no record is found for clicks that means there has been no clicks for the day, multiply by 0
                                let views = 0; // vice versa
                                let impressions = 0;
                                Object.keys(value).map(key => {
                                    if (key == formattedDate + "-c") {
                                        clicks = value[key];
                                    }
                                    if (key == formattedDate + "-v") {
                                        views = value[key];
                                    }
                                    if (key == formattedDate + "-i") {
                                        impressions = value[key];
                                    }
                                })
                                let daysCostOfViews = parseInt(views) * 0.03; // USD
                                let daysCostOfClicks = parseInt(clicks) * 0.15; // USD
                                let daysCostOfImpressions = parseInt(impressions) * 0.0018; // USD
                                let currentDailyCost = daysCostOfClicks + daysCostOfViews + daysCostOfImpressions;
                                console.log(views, clicks, currentDailyCost, adBudget);
                                if (currentDailyCost < adBudget) { // if the ad is under the budget for the day, video is good
                                    resolve(true);
                                } else {
                                    resolve(false); // user must request new playlist
                                }
                            });
                        } else {
                            try {
                            dailyadlimitsclient.hmset(id, formattedDate + "-v", 0, formattedDate + "-c", 1);
                                resolve(true);
                            } catch (err) {
                                reject(false);
                            }
                        }
                    });
                    return incView.then((result) => {
                        return result;
                    })
                } else if (type == "impression") {
                    let incView = new Promise((resolve, reject) => {
                        let date = new Date();
                        let formattedDate = (date.getMonth() + 1) + "/" + date.getDate() + "/" + date.getFullYear();
                        if (contentExists) {
                            dailyadlimitsclient.hincrby(id, formattedDate + "-i", 1);
                            dailyadlimitsclient.hgetall(id, (err, value) => {
                                if (err) {
                                    resolve(false);
                                }
                                let clicks = 0; // if no record is found for clicks that means there has been no clicks for the day, multiply by 0
                                let views = 0; // vice versa
                                let impressions = 0;
                                Object.keys(value).map(key => {
                                    if (key == formattedDate + "-c") {
                                        clicks = value[key];
                                    }
                                    if (key == formattedDate + "-v") {
                                        views = value[key];
                                    }
                                    if (key == formattedDate + "-i") {
                                        impressions = value[key];
                                    }
                                })
                                console.log(value);
                                let daysCostOfViews = parseInt(views) * 0.03; // USD
                                let daysCostOfClicks = parseInt(clicks) * 0.15; // USD
                                let daysCostOfImpressions = parseInt(impressions) * 0.0012; // USD
                                let currentDailyCost = daysCostOfClicks + daysCostOfViews + daysCostOfImpressions;
                                console.log(views, clicks, impressions, currentDailyCost, adBudget);
                                if (currentDailyCost < adBudget) { // if the ad is under the budget for the day, video is good
                                    resolve(true);
                                } else {
                                    resolve(false); // user must request new playlist
                                }
                            });
                        } else {
                            try {
                            dailyadlimitsclient.hmset(id, formattedDate + "-v", 0, formattedDate + "-c", 1);
                                resolve(true);
                            } catch (err) {
                                reject(false);
                            }
                        }
                    });
                    return incView.then((result) => {
                        return result;
                    })
                } else {
                    return null;
                }
            }
        } else {
            return null;
        }
    } catch (err) {
        console.log(err);
    }
    
}

const fetchSingleVideoSimple = async (mpd, ad = false) => {
    let session = driver.session();
    let query = "match (a:Video {mpd: $mpd}) return a";
    if (ad) {
        query = "match (a:AdVideo {mpd: $mpd}) return a";
    }
    let params = { mpd: mpd };
    return await session.run(query, params)
        .then(async (result) => {
            if (result.records) {
                if (result.records[0]) {
                    return result.records[0];
                }
            }
            return null;
        })
}


module.exports = {
    getSearchResults: getSearchResults,
    getRelatedContent: getRelatedContent,
    getRelevantPlaylist: getRelevantPlaylist,
    getRelevantAds: getRelevantAds,
    incrementDailyBudgetRecord: incrementDailyBudgetRecord,
    fetchSingleVideoSimple: fetchSingleVideoSimple
}
