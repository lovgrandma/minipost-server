const s3Cred = require('./api/s3credentials.js');

const serveCloudfrontUrl = (mpd) => {
    if (mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)) {
        mpd = s3Cred.cdn.cloudFront1 + "/" + mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)[2];
    }
    return mpd;
}

exports.serveCloudfrontUrl = serveCloudfrontUrl;
