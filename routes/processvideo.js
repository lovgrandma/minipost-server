const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');
const uuidv4 = require('uuid/v4');
const redis = require('../redis');
const redisclient = redis.redisclient;
const ffmpeg = require('ffmpeg');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const servecloudfront = require('./servecloudfront.js');
const workerpool = require('workerpool');

const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);

// file upload
const aws = require('aws-sdk');
const s3Cred = require('./api/s3credentials.js');
const multer = require('multer');
const multerS3 = require('multer-s3');
aws.config.update(s3Cred.awsConfig);
const s3 = new aws.S3();

// Resolutions for video conversion
const resolutions = [2048, 1440, 1080, 720, 480, 360, 240];
const audioCodecs = ["aac", "ac3", "als", "sls", "mp3", "mp2", "mp1", "celp", "hvxc", "pcm_s16le"];
const supportedContainers = ["mov", "3gpp", "mp4", "avi", "flv", "webm", "mpegts", "wmv", "matroska"];
Object.freeze(resolutions); Object.freeze(audioCodecs);

const storage = multer.memoryStorage();

const createObj = (obj) => {
    let newObj = {};
    return Object.assign(newObj, obj);
}

// connect mongoose
mongoose.connect('mongodb://localhost:27017/minireel')
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log(err));

const db = mongoose.connection;
//mongo error
db.on('error', console.error.bind(console, 'connection error:'));

// mongo store
const store = new MongoDBStore(
    {
        uri: 'mongodb://localhost:27017/minireel',
        databaseName: 'minireel',
        collection: 'sessions'
    }
);

const convertVideos = async function(i, originalVideo, objUrls, generatedUuid, encodeAudio, room, body, io) {
    /* If encode audio is set to true, encode audio and run convertVideos at same iteration, then set encode audio to false at same iteration. Add support in future for multiple audio encodings.
                */
    if (i < resolutions.length) { // Convert if iteration is less than the length of resolutions constant array
        try {
            let process = new ffmpeg(originalVideo, {maxBuffer: 512 * 1000});
            const format = "mp4";
            const audioFormat = "mp4";
            if (encodeAudio) {
                process.then(async function(audio) {
                    if (audioCodecs.indexOf(audio.metadata.audio.codec.toLowerCase()) >= 0) { // Determine if current audio codec is supported
                        if (io) {
                            io.to(room).emit('uploadUpdate', "converting audio file");
                        }
                        let rawPath = "temp/" + generatedUuid + "-audio" + "-raw" + "." + audioFormat;
                        audio.addCommand('-vn');
                        audio.addCommand('-c:a', "aac"); // Convert all audio to aac, ensure consistency of format
                        audio.addCommand('-b:a', '256k');
                        if (audio.metadata.audio.channels.value == null || audio.metadata.audio.channels.value == 0) {
                            audio.addCommand('-ac', '6'); // If channels value is null or equal to 0, convert to surround sound
                        }
                        audio.save("./" + rawPath, async function (err, file) {
                            let audioObj = {
                                "path" : rawPath,
                                "detail" : "aac"
                            }
                            objUrls.push(audioObj);
                            if (!err) {
                                console.log('Audio file: ' + file);
                                convertVideos(i, originalVideo, objUrls, generatedUuid, false, room, body, io);
                            } else {
                                console.log(err);
                                deleteVideoArray(objUrls, originalVideo, room, 100000);
                                if (io) {
                                    io.to(room).emit('uploadErr', "Something went wrong");
                                }
                                return err;
                            }
                        });
                    } else {
                        deleteVideoArray(objUrls, originalVideo, room, 100000);
                        console.log("Audio codec not supported");
                        if (io) {
                            io.to(room).emit('uploadErr', "Audio codec not supported");
                        }
                    }
                });
            } else {
                process.then(async function (video) {
                    if (io) {
                        io.to(room).emit('uploadUpdate', "converting " + resolutions[i] + "p video");
                    }
                    let rawPath = "temp/" + generatedUuid + "-" + resolutions[i] + "-raw" + "." + format;
                    video.setVideoSize("?x" + resolutions[i], true, true).setDisableAudio();
                    video.addCommand('-vcodec', 'libx264');
                    if (video.metadata.video.codec == "mpeg2video") {
                        video.addCommand('-preset', 'slow');
                    } else {
                        video.addCommand('-preset', 'faster');
                    }
                    video.addCommand('-crf', '24');
                    video.addCommand('-tune', 'film');
                    video.addCommand('-x264-params', 'keyint=24:min-keyint=24:no-scenecut');
                    video.save("./" + rawPath, async function (err, file) {
                        let videoObj = {
                            "path" : rawPath,
                            "detail" : resolutions[i]
                        };
                        objUrls.push(videoObj);
                        if (!err) {
                            console.log('Video file: ' + file);
                            convertVideos(i+1, originalVideo, objUrls, generatedUuid, false, room, body, io);
                        } else {
                            console.log(err);
                            deleteVideoArray(objUrls, originalVideo, room, 100000);
                            if (io) {
                                io.to(room).emit('uploadErr', "Conversion error");
                            }
                            return err;
                        }
                    });
                });
            }
        } catch (e) {
            console.log("Error msg: " + e.msg);
            deleteVideoArray(objUrls, originalVideo, room, 100000);
            if (io) {
                io.to(room).emit('uploadErr', "Conversion error");
            }
            return e;
        }
    } else {
        if (io) {
            io.to(room).emit('uploadUpdate', "video conversion complete");
        }
        makeMpd(objUrls, originalVideo, room, body, generatedUuid, io);
    }
    return objUrls;
}

const makeMpd = async function(objUrls, originalVideo, room, body, generatedUuid, io) {
    console.log("Generating Mpd");
    const exec_options = {
        cwd: null,
        env: null,
        encoding: 'utf8',
        timeout: 0,
        maxBuffer: 200 * 1024
    };

    const relative = "../../../../";
    const captureName = /([a-z].*)\/([a-z0-9].*)-/;
    const matchPathExcludePeriod = /([a-z].*)([a-z0-9]*)[.]([a-z].*)/;
    let delArr = [];
    const rawObjUrls = [];
    for (let i = 0; i < objUrls.length; i++) {
        rawObjUrls[i] = createObj(objUrls[i]);
    }
    try {
        let command = "cd scripts/src/out/Release && packager.exe";
        let args = "";
        for (obj of objUrls) {
            let detail = obj.detail;
            let fileType = "";
            if (resolutions.toString().indexOf(obj.detail) >= 0) {
                fileType = "video";
            } else if (audioCodecs.toString().indexOf(obj.detail) >= 0) {
                fileType = "audio";
                detail = "audio";
            } else {
                fileType = "text";
            }
            args += "in=" + relative + obj.path + ",stream=" + fileType + ",output=" + relative + obj.path.match(/([\/a-z0-9]*)-([a-z0-9]*)-([a-z]*)/)[1] + "-" + detail + ".mp4" + " ";
            obj.path = obj.path.match(/([\/a-z0-9]*)-([a-z0-9]*)-([a-z]*)/)[1] + "-" + detail + ".mp4";
        }
        const expectedMpdPath = objUrls[0].path.match(/([\/a-z0-9]*)-([a-z0-9]*)/)[1] + "-mpd.mpd";
        args += "--mpd_output " + relative + expectedMpdPath;
        console.log(command + " " + args);
        let data = cp.exec(command + " " + args, {maxBuffer: 1024 * 8000}, function(err, stdout, stderr) { // 8000kb max buffer
            if (err) {
                console.log("Something went wrong, mpd was not created");
                if (io) {
                    io.to(room).emit('uploadErr', "Conversion error");
                }
                deleteVideoArray(objUrls, originalVideo, room, 12000);
            } else {
                try {
                    if (fs.existsSync("./" + expectedMpdPath)) {
                        let mpdObj = {
                            "path" : expectedMpdPath,
                            "detail" : "mpd"
                        };
                        objUrls.push(mpdObj);
                        uploadAmazonObjects(objUrls, originalVideo, room, body, generatedUuid, rawObjUrls, io);
                    } else {
                        console.log("Something went wrong, mpd was not created");
                        if (io) {
                            io.to(room).emit('uploadErr', "Conversion error");
                        }
                        delArr.push(...objUrls, ...rawObjUrls);
                        deleteVideoArray(delArray, originalVideo, room, 12000);
                    }
                } catch (err) {
                    console.log(err);
                    console.log("Something went wrong, mpd was not created");
                    if (io) {
                        io.to(room).emit('uploadErr', "Conversion error");
                    }
                    delArr.push(...objUrls, ...rawObjUrls);
                    deleteVideoArray(delArray, originalVideo, room, 12000);
                }
            }
        });
    } catch (err) {
        console.log(err);
        console.log("Something went wrong, mpd was not created");
        if (io) {
            io.to(room).emit('uploadErr', "Conversion error");
        }
        delArr.push(...objUrls, ...rawObjUrls);
        deleteVideoArray(delArray, originalVideo, room, 12000);
    }
}

// Uploads individual amazon objects in array to amazon
const uploadAmazonObjects = async function(objUrls, originalVideo, room, body, generatedUuid, rawObjUrls, io) {
    // The locations array will hold the location of the file once uploaded and "detail"
    // Detail will tell the resolution if its a video, the language if its audio or language-s if its a subtitle
    // Use the locations array to build the dash mpd file
    if (io) {
        io.to(room).emit('uploadUpdate', "uploading content to server");
    }
    let s3Objects = [];
    if (objUrls.length == 0) {
        if (io) {
            io.to(room).emit('uploadErr', "Something went wrong");
        }
        deleteVideoArray(delArray, originalVideo, room, 12000);
    }
    let delArr = [];
    const keyRegex = /[a-z].*\/([a-z0-9].*)/; // Matches entire key
    const resoRegex = /-([a-z0-9].*)\./; // Matches the detail data at the end of the object key
    let uploadData;
    for (let i = 0; i < objUrls.length; i++) {
        try {
            let data = fs.createReadStream(objUrls[i].path);
            uploadData = await s3.upload({ Bucket: 'minifs', Key: objUrls[i].path.match(keyRegex)[1], Body: data }).promise();
            if (await uploadData) { // Wait for data to be uploaded to S3
                s3Objects.push({location: uploadData.Location, detail: uploadData.Key.match(resoRegex)[1]});
                console.log(uploadData);
                if (data) {
                    if (i == objUrls.length-1) {
                        console.log("Upload to S3 Complete");
                        console.log(room);
                        makeVideoRecord(s3Objects, body, generatedUuid, io);
                        delArr.push(...objUrls, ...rawObjUrls);
                        deleteVideoArray(delArr, originalVideo, room, 12000);
                        if (io) {
                            io.to(room).emit('uploadUpdate', "upload complete");
                        }
                    }
                }
            } else {
                console.log("Something went wrong, not all objects uploaded to s3");
                if (io) {
                    io.to(room).emit('uploadErr', "Something went wrong");
                }
                delArr.push(...objUrls, ...rawObjUrls);
                deleteVideoArray(delArray, originalVideo, room, 12000);
            }
        } catch (err) {
            console.log("Something went wrong, not all objects uploaded to s3");
            if (io) {
                io.to(room).emit('uploadErr', "Something went wrong");
            }
            delArr.push(...objUrls, ...rawObjUrls);
            deleteVideoArray(delArray, originalVideo, room, 12000);
        }
    }
};

const makeVideoRecord = async function(s3Objects, body, generatedUuid, io) {
    let objLocations = [];
    let mpdLoc = "";
    for (obj of s3Objects) {
        objLocations.push(obj.location);
        if (obj.location.match(/.*(mpd).*/)) {
            mpdLoc = obj.location.match(/.*(mpd).*/)[0];
        }
    }
    let videoRecord = await Video.findOneAndUpdate({ _id: generatedUuid }, {$set: { mpd: mpdLoc, locations: objLocations, state: Date.parse(new Date) }}, { new: true });
    if (await videoRecord) {
        let mpd;
        if (videoRecord.mpd) mpd = videoRecord.mpd;
        let userObj = await User.findOne({ username: body.user });
        for (let i = 0; i < userObj.videos.length; i++) {
            if (userObj.videos[i].id == generatedUuid) {
                let awaitingInfo = function() {
                    if (videoRecord.title.length == 0) {
                        return ";awaitinginfo";
                    } else {
                        return "";
                    }
                }
                let userVideoRecord = await User.findOneAndUpdate({ username: body.user, "videos.id": generatedUuid }, {$set: { "videos.$" : {id: generatedUuid, state: Date.parse(new Date).toString() + awaitingInfo() }}}, { upsert: true, new: true});
                if (await userVideoRecord) {
                    if (io) {
                        io.to(room).emit('uploadUpdate', "video ready;" + servecloudfront.serveCloudfrontUrl(mpd));
                    }
                }
            }
        }
    }
}

// Deletes originally converted videos from temporary storage (usually after they have been uploaded to an object storage) Waits for brief period of time after amazon upload to ensure files are not being used.
const deleteVideoArray = function(videos, original, room, delay) {
    setTimeout(function() {
        for (let i = 0; i < videos.length; i++) {
            try {
                let object = videos[i].path;
                fs.unlink(videos[i].path, (err) => {
                    if (err) {
                        console.log(err);
                    } else {
                        console.log(object + " deleted from temp storage");
                    }
                });
            } catch (err) {
                console.log(err);
            }
        };
        try {
            fs.unlink(original, (err) => {
                if (err) {
                    setTimeout((original) => {
                        fs.unlink(original, (err) => {
                            console.log("Original video deleted from temp storage on second try");
                        });
                    }, 500000);
                } else {
                    console.log("Original video deleted from temp storage");
                }
            });
        } catch (err) {
            console.log(err);
        }
    }, delay);
}

/* Deletes one file cleanly */
const deleteOne = async (filePath) => {
    try {
        fs.unlink(filePath, (err) => {
            if (err) {
                throw err;
            } else {
                console.log(filePath + " deleted");
            }
        });
    } catch (err) {
        console.log(err);
    }
}

workerpool.worker({
    convertVideos: convertVideos
});

exports.convertVideos = convertVideos;
exports.deleteOne = deleteOne;
exports.createObj = createObj;
exports.deleteVideoArray = deleteVideoArray;
exports.resolutions = resolutions;
exports.audioCodecs = audioCodecs;
exports.supportedContainers = supportedContainers;
