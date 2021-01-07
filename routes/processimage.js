// Takes thumbnail file and uploads to s3. Returns s3 url

const fs = require('fs');
const uuidv4 = require('uuid/v4');
const { deleteOne } = require('./utility');
// file upload
const aws = require('aws-sdk');
const s3Cred = require('./api/s3credentials.js');
const multer = require('multer');
aws.config.update(s3Cred.awsConfig);
const s3 = new aws.S3();

// Set timeout to delete one left over thumbfile
async function doImgDeletion(thumbFile) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve(deleteOne(thumbFile));
        }, 1500);
    });
}

// Generates a unique uuid for a thumbnail file and uploads said file to s3 if no existing object with same uuid (try 3 times) was found
// Return uuid of thumbnail
const processThumb = async (thumbFile) => {
    try {
        let i = 0;
        let checkExistingObject = null;
        let generatedUuid = null;
        let uploadData;
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
                return doImgDeletion(thumbFile).then(() => {
                    return generatedUuid;
                })
            }
        } else {
            return '';
        }
    } catch (err) {
        return '';
    }
}

module.exports = { processThumb: processThumb };
