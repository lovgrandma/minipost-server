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

const processVideo = async (req, res, next, io) => {
    // 1) Check video file to ensure that file is viable for encoding, gets file info of temporarily saved file. Uses path to determine if viable for ffmpeg conversion
    let objUrls = [];
    try {
        const body = req.body;
        let fileInfo = path.parse(req.file.filename);
        let originalVideo = './temp/' + fileInfo.name + fileInfo.ext;
        let process = new ffmpeg(originalVideo);
        let userDbObject = await User.findOne({ username: body.user }).lean();
        let currentlyProcessing = false;
        let room = "";
        if (userDbObject) { // Determines if video object has been recently processed. Useful for double post requests made by browser
            for (video of userDbObject.videos) {
                if (video) {
                    if (video.state) {
                        if (video.state.toString().match(/([a-z0-9].*);processing/)) {
                            console.log("Db shows video already processing");
                            room = "upl-" + video.id;
                            res.end("processbegin;upl-" + video.id);
                            currentlyProcessing = true;
                            break;
                        }
                    }
                }
            }
        } else {
            res.status(500).send({ querystatus: "Something went wrong" });
        }
        if (userDbObject && currentlyProcessing == false) {
            process.then(async function (video) {
                // If file is MOV, 3GPP, AVI, FLV, MPEG4, WebM or WMV continue, else send response download "Please upload video of type ..
                console.log(video.metadata.video);
                console.log(video.metadata.audio);
                console.log(video.metadata.duration);
                // Video resolution, example 1080p
                let resolution = video.metadata.video.resolution.h;
                let container = video.metadata.video.container.toLowerCase();
                if (supportedContainers.indexOf(container) >= 0) {
                    // Run ffmpeg convert video to lower method as many times as there is a lower video resolution
                    // Determine what resolution to downgrade to
                    if (resolution >= 240) {
                        let ranOnce = false;
                        let l = 0;
                        // Creates a unique uuid for the amazon objects and then converts using ffmpeg convertVideos()
                        function createUniqueUuid() {
                            let generatedUuid = uuidv4().split("-").join("");
                            let checkExistingObject = s3.getObject({ Bucket: "minifs", Key: generatedUuid + "-360.mp4", Range: "bytes=0-9" }).promise();
                            checkExistingObject.then(async (data, err) => {
                                l++;
                                if (data) { // If data was found, generated uuid is not unique. Max 3 tries
                                    if (l < 3) {
                                        return createUniqueUuid();
                                    } else {
                                        res.status(500).send({ querystatus: "Max calls to video storage exceeded, could not find unique uuid", err: "reset" });
                                        deleteOne(originalVideo);
                                    }
                                } else {
                                    res.status(500).send({ querystatus: "Max calls to video storage exceeded, could not find unique uuid", err: "reset" });
                                    deleteOne(originalVideo);
                                }
                            }).catch(async error => {
                                console.log("No data found with generatedUUID on object storage, processing");
                                room = "upl-" + generatedUuid; // Socket for updating user on video processing progress
                                for (let i = 0; i < resolutions.length; i++) {
                                    // If the resolution of the video is equal to or greater than the iterated resolution, convert to that res and develop copies recursively to lowest resolution
                                    console.log("Resolution " + resolution + " >= " + resolutions[i] + " ?");
                                    if (resolution == resolutions[i] || resolution > resolutions[i]) { // Convert at current resolution if match
                                        if (!ranOnce) {
                                            let status = Date.parse(new Date) + ";processing";
                                            let videoData = {
                                                _id: generatedUuid,
                                                title: "",
                                                description: "",
                                                tags: [],
                                                mpd: "",
                                                locations: [],
                                                author: body.user,
                                                upvotes: 0,
                                                downvotes: 0,
                                                state: status
                                            };
                                            let videoRef = {
                                                id: generatedUuid,
                                                state: status
                                            }
                                            let createdVideoObj = await Video.create(videoData);
                                            if (createdVideoObj) {
                                                let userObj = await User.findOneAndUpdate({ username: body.user }, {$addToSet: { "videos": videoRef }}, {upsert: true, new: true});
                                                if (userObj) {
                                                    res.status(200).send({querystatus: "processbegin;" + room}); // Send room back to user so user can connect to socket
                                                    ranOnce = true;
                                                    objUrls = await convertVideos(i, originalVideo, objUrls, generatedUuid, true, room, body, io);
                                                    return objUrls;
                                                } else {
                                                    if (!ranOnce) {
                                                        res.status(200).send({ querystatus: "Something went wrong", err: "reset" });
                                                        deleteOne(originalVideo);
                                                    }
                                                }
                                            } else {
                                                if (!ranOnce) {
                                                    res.status(200).send({ querystatus: "Something went wrong", err: "reset" });
                                                    deleteOne(originalVideo);
                                                }
                                            }
                                        }
                                    }
                                };
                                if (!ranOnce) {
                                    res.status(200).send({ querystatus: "Bad Resolution", err: "reset" });
                                    deleteOne(originalVideo);
                                }
                            })
                        };
                        createUniqueUuid();
                    } else {
                        res.status(200).send({ querystatus: "Bad Resolution", err: "reset" });
                        deleteOne(originalVideo);
                    }
                } else {
                    res.status(200).send({ querystatus: "Invalid video container", err: "reset" });
                    deleteOne(originalVideo);
                }
            }).catch(error => {
                console.log(error);
            });
        } else {
            io.to(room).emit('uploadUpdate', "processing;" + room); // Send upload update to room if video is already processing from previous request
        }
    } catch (e) {
        console.log(e);
    }
};

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
                        io.to(room).emit('uploadUpdate', "converting audio file");
                        audio.addCommand('-vn');
                        audio.addCommand('-c:a', "aac"); // Converts audio if in other format
                        let rawPath = "temp/" + generatedUuid + "-audio" + "-raw" + "." + audioFormat;
                        audio.addCommand('-b:a', '256k');
                        if (audio.metadata.audio.channels.value == 0 || audio.metadata.audio.channels.value > 2) {
                            audio.addCommand('-ac', '2'); // Force to 2 channels. Prevents errors when more than 2 channels (e.g 6 surround)
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
                                io.to(room).emit('uploadErr', "Something went wrong");
                                return err;
                            }
                        });
                    } else {
                        deleteVideoArray(objUrls, originalVideo, room, 100000);
                        console.log("Audio codec not supported");
                        io.to(room).emit('uploadErr', "Audio codec not supported");
                    }
                });
            } else {
                process.then(async function (video) {
                    io.to(room).emit('uploadUpdate', "converting " + resolutions[i] + "p video");
                    let rawPath = "temp/" + generatedUuid + "-" + resolutions[i] + "-raw" + "." + format;
                    video.setVideoSize("?x" + resolutions[i], true, true).setDisableAudio();
                    video.addCommand('-vcodec', 'libx264');
                    video.addCommand('-crf', '24');
                    video.addCommand('-preset', 'faster');
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
                            io.to(room).emit('uploadErr', "Conversion error");
                            return err;
                        }
                    });
                });
            }
        } catch (e) {
            console.log("Error msg: " + e.msg);
            deleteVideoArray(objUrls, originalVideo, room, 100000);
            io.to(room).emit('uploadErr', "Conversion error");
            return e;
        }
    } else {
        io.to(room).emit('uploadUpdate', "video conversion complete");
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
                io.to(room).emit('uploadErr', "Conversion error");
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
                        io.to(room).emit('uploadErr', "Conversion error");
                        delArr.push(...objUrls, ...rawObjUrls);
                        deleteVideoArray(delArray, originalVideo, room, 12000);
                    }
                } catch (err) {
                    console.log(err);
                    console.log("Something went wrong, mpd was not created");
                    io.to(room).emit('uploadErr', "Conversion error");
                    delArr.push(...objUrls, ...rawObjUrls);
                    deleteVideoArray(delArray, originalVideo, room, 12000);
                }
            }
        });
    } catch (err) {
        console.log(err);
        console.log("Something went wrong, mpd was not created");
        io.to(room).emit('uploadErr', "Conversion error");
        delArr.push(...objUrls, ...rawObjUrls);
        deleteVideoArray(delArray, originalVideo, room, 12000);
    }
}

// Uploads individual amazon objects in array to amazon
const uploadAmazonObjects = async function(objUrls, originalVideo, room, body, generatedUuid, rawObjUrls, io) {
    // The locations array will hold the location of the file once uploaded and "detail"
    // Detail will tell the resolution if its a video, the language if its audio or language-s if its a subtitle
    // Use the locations array to build the dash mpd file
    io.to(room).emit('uploadUpdate', "uploading content to server");
    let s3Objects = [];
    if (objUrls.length == 0) {
        io.to(room).emit('uploadErr', "Something went wrong");
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
                        io.to(room).emit('uploadUpdate', "upload complete");
                        makeVideoRecord(s3Objects, body, generatedUuid, io);
                        delArr.push(...objUrls, ...rawObjUrls);
                        deleteVideoArray(delArr, originalVideo, room, 12000);
                    }
                }
            } else {
                console.log("Something went wrong, not all objects uploaded to s3");
                io.to(room).emit('uploadErr', "Something went wrong");
                delArr.push(...objUrls, ...rawObjUrls);
                deleteVideoArray(delArray, originalVideo, room, 12000);
            }
        } catch (err) {
            console.log("Something went wrong, not all objects uploaded to s3");
            io.to(room).emit('uploadErr', "Something went wrong");
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

    Video.findOneAndUpdate({ _id: generatedUuid }, {$set: { mpd: mpdLoc, locations: objLocations, state: Date.parse(new Date) }}, { new: true }, async function( err, result) {
        let mpd;
        if (result.mpd) mpd = result.mpd;
        let userObj = await User.findOne({ username: body.user });
        for (let i = 0; i < userObj.videos.length; i++) {
            if (userObj.videos[i].id == generatedUuid) {
                let awaitingInfo = "";
                if (result.title.length == 0) { // If user has not entered a title, the video still requires info from the user
                    awaitingInfo = ";awaitinginfo";
                }
                User.findOneAndUpdate({ username: body.user, "videos.id": generatedUuid }, {$set: { "videos.$" : {id: generatedUuid, state: Date.parse(new Date).toString() + awaitingInfo }}}, { upsert: true, new: true},
                                      async function(err, user) {
                    io.to(room).emit('uploadUpdate', "video ready;" + servecloudfront.serveCloudfrontUrl(mpd));
                })
            }
        }
    });
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

exports.processVideo = processVideo;
exports.deleteOne = deleteOne;
exports.createObj = createObj;
exports.deleteVideoArray = deleteVideoArray;
