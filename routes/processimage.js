// Takes thumbnail file and uploads to s3. Returns s3 url

const fs = require('fs');
const uuidv4 = require('uuid/v4');
// file upload
const aws = require('aws-sdk');
const s3Cred = require('./api/s3credentials.js');
const multer = require('multer');
aws.config.update(s3Cred.awsConfig);
const s3 = new aws.S3();

const processThumb = async (thumbFile) => {
    let i = 0;
    let checkExistingObject = null;
    let generatedUuid = null;
    let uploadData;
    console.log(thumbFile);
    do {
        generatedUuid = uuidv4().split("-").join("");
        try {
            checkExistingObject = await s3.getObject({ Bucket: "minifs-thumbnails", Key: generatedUuid + ".jpeg", Range: "bytes=0-9" }).promise();
        } catch (err) { // No image was found with matching uuid, use current uuid to make thumbnail image
            i = 3;
        }
        if (await checkExistingObject) {
            generatedUuid = null;
            i++;
        }
    } while (i < 3);
    if (generatedUuid) {
        let data = fs.createReadStream(thumbFile);
        uploadData = await s3.upload({ Bucket: 'minifs-thumbnails', Key: generatedUuid + ".jpeg", Body: data }).promise();
        if (uploadData) {
            return generatedUuid;
        }
    }
    return false;
}

module.exports = { processThumb: processThumb };
