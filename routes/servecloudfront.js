const s3Cred = require('./api/s3credentials.js');

const serveCloudfrontUrl = (mpd) => {
    // Matches mpd format: https://minifs.s3.us-east-2.amazonaws.com/00fc4ad8fbf94b62a3bdd049dc6e581a-mpd.mpd
    if (mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)) {
        mpd = s3Cred.cdn.cloudFront1 + "/" + mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)[2];
    } else if (mpd.match(/([a-zA-Z0-9].*)/)) { // Matches raw mpd format: d441b557886849f4bdfa23e5fee38f22
        mpd = s3Cred.cdn.cloudFront1 + "/" + mpd.match(/([a-zA-Z0-9].*)/)[1];
    }
    return mpd;
}

// Policy for cloudfront cookies
const policy = JSON.stringify({
    Statement: [
        {
            Resource: 'http*://d3oyqm71scx51z.cloudfront.net/*',
            Condition: {
                DateLessThan: {
                    'AWS:EpochTime':
                    Math.floor(new Date().getTime() / 1000) + 60 * 60 * 1, // Current Time in UTC + time in seconds, (60 * 60 * 1 = 1 hour)
                },
            }
        }
    ]
})

exports.serveCloudfrontUrl = serveCloudfrontUrl;
exports.policy = policy;
