const aws = require('aws-sdk');
const s3Cred = require('./api/s3credentials.js');
aws.config.update(s3Cred.awsConfig);
aws.config.apiVersions = {
    sqs: '2012-11-05',
    // other service API versions
};
const s3 = new aws.S3();
const sqs = new aws.SQS();
const rekognition = new aws.Rekognition();
let sqsQueue = s3Cred.awsConfig.sqsQueue;

const badLabels = ['Sexual Activity', 'Explicit Nudity', 'Nudity', 'Graphic Male Nudity', 'Graphic Female Nudity'];
// 85% on explicit nudity as cut off for content
const getProfanityData = async (jobId, status) => {
    try {
        let data = await new Promise( async (resolve, reject) => {
            const params = {
                JobId: jobId
            }
            let defer = false;
            if (status.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)) {
                if (status.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[2] != 0) {
                    let d = new Date();
                    if (status.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*)/)[2] > d.getTime()) {
                        defer = true;
                    }
                }
            }
            if (!defer) {
                rekognition.getContentModeration(params, async (err, data) => {
                    if (err) {
                        return reject(err);
                    } else {
                        return resolve(data);
                    }
                });
            } else {
                resolve('wait');
            }
        });
        console.log(data);
        if (data) {
            if (data == 'wait') {
                return {
                    profanity: 0,
                    status: 'wait',
                    jobId: jobId
                }
            } else if (data.ModerationLabels.length == 0 && data.JobStatus != 'IN_PROGRESS') {
                return {
                    profanity: 0,
                    status: 'good',
                    jobId: jobId
                }
            } else if (data.JobStatus == 'IN_PROGRESS') {
                return {
                    profanity: 0,
                    status: 'in_progress',
                    jobId: jobId
                }
            } else {
                let pornographic = [];
                for (let i = 0; i < data.ModerationLabels.length; i++) {
                    if (badLabels.indexOf(data.ModerationLabels[i].ModerationLabel.Name) >= 0 && data.ModerationLabels[i].ModerationLabel.Confidence > 85) {
                        pornographic.push(data.ModerationLabels[i].ModerationLabel.Name);
                    } else if (badLabels.indexOf(data.ModerationLabels[i].ModerationLabel.ParentName) >= 0 && data.ModerationLabels[i].ModerationLabel.Confidence > 85) {
                        pornographic.push(data.ModerationLabels[i].ModerationLabel.ParentName);
                    }
                }
                let status = pornographic.length > 0 ? 'bad' : 'good';
                console.log(pornographic.length);
                return {
                    profanity: pornographic.length,
                    status: status,
                    jobId: jobId
                }
            }
        } else {
            return {
                profanity: 0,
                status: 'noresult',
                jobId: jobId
            }
        }
    } catch (err) {
        console.log(err);
    }
}


module.exports = {
    getProfanityData: getProfanityData,
    badLabels: badLabels
}
