const neo4j = require('neo4j-driver');
const neo = require('./neo.js');
const s3Cred = require('./api/s3credentials.js');
const driver = neo4j.driver(s3Cred.neo.address, neo4j.auth.basic(s3Cred.neo.username, s3Cred.neo.password));

"CALL db.index.fulltext.createNodeIndex(\"goodVideos\",[\"gVideo\"],[\"title\", \"description\", \"author\", \"tags\", \"mpd\", \"thumbnailUrl\", \"views\", \"publishDate\"])";

const quarantineVideo = async (profanityJob, uuid, type = "Video") => {
    let session = driver.session();
    let status = profanityJob.status;
    if (uuid) {
        let query = "match (a:Video { mpd: $uuid}) set a += { status: $status } return a";
        if (type == "AdVideo") {
            query = "match (a:AdVideo { mpd: $uuid}) set a += { status: $status } return a";
        }
        let params = { uuid: uuid, status: status };
        return session.run(query, params)
            .then((record) => {
                if (status == 'good') {
                    let changeLabelQuery = 'match (a:Video {mpd: $uuid}) call apoc.create.addLabels(a, [\"gVideo\"]) yield node return a'; 
                    if (type == "AdVideo") {
                        changeLabelQuery = 'match (a:AdVideo {mpd: $uuid}) call apoc.create.addLabels(a, [\"gAdVideo\"]) yield node return a'; 
                    }
                    let session2 = driver.session();
                    return session2.run(changeLabelQuery, params)
                        .then((result) => {
                            return record;
                        });
                } else {
                    return record;
                }
            });
    } else {
        return null;
    }
}

const defer = async (jobId, uuid, minutes) => {
    let session = driver.session();
    let d = new Date();
    let status = 'waiting;' + (d.getTime() + (minutes*60000));
    if (uuid) {
        let query = "match (a:Video { mpd: $uuid}) set a += { status: $status } return a";
        let params = { uuid: uuid, status: status };
        return session.run(query, params)
            .then((record) => {
            return record;
        });
    } else {
        return null;
    }

}

module.exports = {
    quarantineVideo: quarantineVideo,
    defer: defer
}
