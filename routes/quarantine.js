const neo4j = require('neo4j-driver');
const neo = require('./neo.js');
const s3Cred = require('./api/s3credentials.js');
const driver = neo4j.driver(s3Cred.neo.address, neo4j.auth.basic(s3Cred.neo.username, s3Cred.neo.password));


const quarantineVideo = async (profanityJob, uuid) => {
    let session = driver.session();
    let status = profanityJob.status;
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
