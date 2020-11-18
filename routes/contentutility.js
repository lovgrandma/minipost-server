// Remove all records with empty titles, are not published or have bad state(profanity found, user lost posting permissions, etc). This will remove videos that have been uploaded to db but have not yet been published/available for public
const removeInvalidVideos = (graphRecords) => {
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
                  appendArticleResponses: appendArticleResponses
                 };
