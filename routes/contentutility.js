const processprofanity = require('./processprofanity.js');
const quarantine = require('./quarantine.js');
// Remove all records with empty titles, are not published or have bad state(profanity found, user lost posting permissions, etc). This will remove videos that have been uploaded to db but have not yet been published/available for public
const removeInvalidVideos = async (graphRecords) => {
    graphRecords = await removeBadVideos(graphRecords).then( async (graphRecords) => {
        graphRecords.forEach((record, i) => {
            if (record._fields) {
                if (record._fields[0]) {
                    if (record._fields[0].properties) {
                        if (!record._fields[0].properties.title || !record._fields[0].properties.published) {
                            graphRecords.splice(i, 1);
                        }
                    }
                }
            }
        })
        return graphRecords;
    });
    return graphRecords;
}

// Removes videos with pornographic material or ones that do not return profanity filter results
// This successfully removes pornographic videos and returns videos that are good to view. Once the video is queried once with the profanity data, it should
// update the information on the db with a quarantine method
const removeBadVideos = async (graphRecords, field = 0) => {
    let promises = graphRecords.map( async record => {
        let profanityPromise = await new Promise( async (resolve, reject) => {
            if (record._fields[field].properties.id) { // is type article, good (for now)
                resolve({profanity: 0, status: 'good', jobId: record._fields[field].properties.profanityJobId });
            }
            if (!record._fields[field].properties.status) {
                resolve({profanity: 1, status: 'bad', jobId: record._fields[field].properties.profanityJobId });
            } else if (record._fields[field].properties.status != 'good') {
                if (record._fields[field].properties.profanityJobId == "") {
                    resolve({profanity: 0, status: 'waiting', jobId: ''});
                } else if (record._fields[field].properties.status == 'bad') {
                    resolve({profanity: 1, status: 'bad', jobId: record._fields[field].properties.profanityJobId });
                } else if (record._fields[field].properties.status.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)) { // waiting with defer time period
                    let profanityResult = await processprofanity.getProfanityData(record._fields[field].properties.profanityJobId, record._fields[field].properties.status);
                    console.log(profanityResult);
                    if (profanityResult.status == 'bad' || profanityResult.status == 'good') {
                        quarantine.quarantineVideo(profanityResult, record._fields[field].properties.mpd);
                    } else if (profanityResult.status == 'in_progress') {
                        quarantine.defer(profanityResult, record._fields[field].properties.mpd, 5); // defer by 5 minutes
                    }
                    resolve(profanityResult);
                }
            } else if (record._fields[field].properties.status == 'good') {
                resolve({profanity: 0, status: 'good', jobId: record._fields[field].properties.profanityJobId });
            } else {
                resolve({profanity: 0, status: 'null', jobId: record._fields[field].properties.profanityJobId });
            }
        })
        if (profanityPromise.status == 'good') {
            return record;
        } else {
            return null;
        }
    });
    let result = await Promise.all(promises);
    for (let i = 0; i < result.length; i++) {
        if (result[i] == null) {
            result.splice(i, 1);
            i--;
        }
    }
    return result;
}

// Appends appropriate article responses to respective records of content
const appendArticleResponses = (graphRecords) => {
    try {
        graphRecords.forEach((record, i) => {
            graphRecords[i]._fields[0].properties.articles = [];
            let found = 0;
            for (let j = 0; j < graphRecords.length; j++) {
                if (record._fields[0].properties.mpd) {
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
                } else {
                    if (record._fields[0].properties.id === graphRecords[j]._fields[0].properties.id) {
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
            }
            let views = 0;
            if (record._fields[0].properties.views) {
                views = record._fields[0].properties.views.toNumber();
            }
            graphRecords[i]._fields[0].properties.views = views;
        });
        return graphRecords;
    } catch (err) {
        return graphRecords;
    }
}

module.exports = { removeInvalidVideos: removeInvalidVideos,
                  appendArticleResponses: appendArticleResponses,
                  removeBadVideos: removeBadVideos
                 };
