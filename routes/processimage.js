// Takes thumbnail file and uploads to s3. Returns s3 url

const fs = require('fs');
const uuidv4 = require('uuid/v4');
const neo = require('./neo.js');
const { deleteOne } = require('./utility');
// file upload
const aws = require('aws-sdk');
const rekognition = new aws.Rekognition();
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
// Manipulate to be used for either video thumbnail or avatar
const processThumb = async (thumbFile, type = 'video') => {
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

let detectProfanityOnImg = async (path) => {
    let createBuffer = new Promise( async (resolve, reject) => {
        fs.readFile(path, (err, data) => {
            if (err) {
                deleteOne(path);
                reject('err');
            }
            let str  = data.toString('base64');
            resolve(Buffer.from(str, 'base64'));
        });
    });

    let getLabels = (data) => {
        try {
            return new Promise( async (resolve, reject) => {
                let params = {
                    Image: {
                        Bytes: data
                    }
                }
                rekognition.detectModerationLabels(params, function(err, data) {
                    if (err) {
                        deleteOne(path);
                        reject('err');
                    }
                    resolve(data);
                })
            })
        } catch (err) {
            deleteOne(path);
            return 'err';
        }
    };
    return await createBuffer.then((data) => {
        return getLabels(data);
    })
    .catch((err) => {
        deleteOne(path);
        return 'err';
    })
}

// Uploads avatar to s3 and updates user record on dbs
const uploadAvatarAndUpdateRecord = async (user, path) => {
    try {
        let uploadData;
        let data = fs.createReadStream(path);
        uploadData = await s3.upload({ Bucket: 'minifs-avatar', Key: "av/" + path.match(/[a-z].*[\\\/]([a-z0-9].*)/)[1], Body: data }).promise();
        if (uploadData) { // Wait for data to be uploaded to S3
            let data = await neo.setUserThumbnail(user, uploadData.Location.match(/[a-z].*[\\\/]([a-z0-9].*)/)[1]);
            if (data) {
                doImgDeletion(path);
                return data;
            } else {
                doImgDeletion(path);
                return false;
            }
        }
    } catch (err) {
        console.log(err);
    }
}

module.exports = { processThumb: processThumb,
                 detectProfanityOnImg: detectProfanityOnImg,
                 uploadAvatarAndUpdateRecord: uploadAvatarAndUpdateRecord };
