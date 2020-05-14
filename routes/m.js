/** Main Routes file m.js
@version 1.0
@author Jesse Thompson
Handles calls to mongodb, user authentication, chat functionality, video upload and records etc
*/

const express = require('express');
const router = express.Router();
const util = require('util');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');
const uuidv4 = require('uuid/v4');
const redisapp = require('../redis');
const redisclient = redisapp.redisclient;
const stringify = require('json-stringify-safe');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg');
const streamifier = require('streamifier');
const cp = require('child_process');

module.exports = function(io) {
    // file upload
    const aws = require('aws-sdk');
    const s3Cred = require('./api/s3credentials.js');
    const multer = require('multer');
    const multerS3 = require('multer-s3');
    aws.config.update(s3Cred.awsConfig);
    const s3 = new aws.S3();

    // Resolutions for video conversion
    const resolutions = [2048, 1440, 1080, 720, 480, 360];
    const audioCodecs = ["aac", "ac3", "als", "sls", "mp3", "mp2", "mp1", "celp", "hvxc"];
    const supportedContainers = ["mov", "3gpp", "mp4", "avi", "flv", "webm", "mpegts", "wmv"];
    Object.freeze(resolutions); Object.freeze(audioCodecs);
    const captureS3Object = /([a-z].*)\/([a-z].*[0-9)].*)-/; // Matches name on s3 object url

    process.env.PUBLIC_KEY = fs.readFileSync(s3Cred.cloudFrontKeysPath.public, 'utf8');
    process.env.PRIVATE_KEY = fs.readFileSync(s3Cred.cloudFrontKeysPath.private , 'utf8');
    // Credentials for cloudFront cookie signing
    const cloudFront = new aws.CloudFront.Signer(
        process.env.PUBLIC_KEY,
        process.env.PRIVATE_KEY
    );

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

    /* Uploads single video to temporary storage to be used to check if video is viable for converting */
    const uploadCheck = multer({
        storage: multer.diskStorage({
            destination: './temp/',
            filename: function(req, file, cb) {
                cb( null, uuidv4().split("-").join("") + "." + req.body.extension);
            }
        })
    });

    const storage = multer.memoryStorage();
    const file = multer({
        storage,
        fileFilter: (req, file, cb) => {
            return cb(null, true);
        }
    }).any();

    const createObj = (obj) => {
        let newObj = {};
        return Object.assign(newObj, obj);
    }

    const makeMpd = async function(objUrls, originalVideo, room, body, generatedUuid) {
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
            let data = cp.exec(command + " " + args, function(err, stdout, stderr) {
                if (err) {
                    console.log("Something went wrong, mpd was not created");
                    io.to(room).emit('uploadErr', "Conversion error");
                    deleteVideoArray(objUrls, originalVideo, room);
                } else {
                    try {
                        if (fs.existsSync("./" + expectedMpdPath)) {
                            let mpdObj = {
                                "path" : expectedMpdPath,
                                "detail" : "mpd"
                            };
                            objUrls.push(mpdObj);
                            uploadAmazonObjects(objUrls, originalVideo, room, body, generatedUuid, rawObjUrls);
                        } else {
                            console.log("Something went wrong, mpd was not created");
                            io.to(room).emit('uploadErr', "Conversion error");
                            delArr.push(...objUrls, ...rawObjUrls);
                            deleteVideoArray(delArray, originalVideo, room);
                        }
                    } catch (err) {
                        console.log(err);
                        console.log("Something went wrong, mpd was not created");
                        io.to(room).emit('uploadErr', "Conversion error");
                        delArr.push(...objUrls, ...rawObjUrls);
                        deleteVideoArray(delArray, originalVideo, room);
                    }
                }
            });
        } catch (err) {
            console.log(err);
            console.log("Something went wrong, mpd was not created");
            io.to(room).emit('uploadErr', "Conversion error");
            delArr.push(...objUrls, ...rawObjUrls);
            deleteVideoArray(delArray, originalVideo, room);
        }
    }

    const makeVideoRecord = async function(s3Objects, body, generatedUuid) {
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
                            io.to(room).emit('uploadUpdate', "video ready;" + serveCloudFrontUrl(mpd));
                        })
                }
            }
        });
    }

    // Uploads individual amazon objects in array to amazon
    const uploadAmazonObjects = async function(objUrls, originalVideo, room, body, generatedUuid, rawObjUrls) {
        // The locations array will hold the location of the file once uploaded and "detail"
        // Detail will tell the resolution if its a video, the language if its audio or language-s if its a subtitle
        // Use the locations array to build the dash mpd file
        io.to(room).emit('uploadUpdate', "uploading content to server");
        let s3Objects = [];
        if (objUrls.length == 0) {
            io.to(room).emit('uploadErr', "Something went wrong");
            deleteVideoArray(delArray, originalVideo, room);
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
                            io.to(room).emit('uploadUpdate', "upload complete");
                            makeVideoRecord(s3Objects, body, generatedUuid);
                            delArr.push(...objUrls, ...rawObjUrls);
                            deleteVideoArray(delArr, originalVideo, room);
                        }
                    }
                } else {
                    console.log("Something went wrong, not all objects uploaded to s3");
                    io.to(room).emit('uploadErr', "Something went wrong");
                    delArr.push(...objUrls, ...rawObjUrls);
                    deleteVideoArray(delArray, originalVideo, room);
                }
            } catch (err) {
                console.log("Something went wrong, not all objects uploaded to s3");
                io.to(room).emit('uploadErr', "Something went wrong");
                delArr.push(...objUrls, ...rawObjUrls);
                deleteVideoArray(delArray, originalVideo, room);
            }
        }
    };

    // Deletes originally converted videos from temporary storage (usually after they have been uploaded to an object storage) Waits for brief period of time after amazon upload to ensure files are not being used.
    const deleteVideoArray = function(videos, original, room) {
        setTimeout(function() {
            for (let i = 0; i < videos.length; i++) {
                try {
                    let object = videos[i].path;
                    fs.unlink(videos[i].path, (err) => {
                        if (err) {
                            throw err
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
                        throw err;
                    } else {
                        console.log("Original video deleted from temp storage");
                    }
                });
            } catch (err) {
                console.log(err);
            }
        }, 12000);
    }

    const convertVideos = async function(i, originalVideo, objUrls, generatedUuid, encodeAudio, room, body) {
        /* If encode audio is set to true, encode audio and run convertVideos at same iteration, then set encode audio to false at same iteration. Add support in future for multiple audio encodings.
                */
        if (i < resolutions.length) { // Convert if iteration is less than the length of resolutions constant array
            try {
                let process = new ffmpeg(originalVideo);
                const format = "mp4";
                const audioFormat = "mp4";
                if (encodeAudio) {
                    process.then(async function(audio) {
                        if (audioCodecs.indexOf(audio.metadata.audio.codec.toLowerCase()) >= 0) { // Determine if current audio codec is supported
                            audio.addCommand('-vn');
                            if (audio.metadata.audio.codec.toLowerCase() == "aac") {
                                audio.addCommand('-c:a', "copy"); // Copies current audio format if already in aac format, fast
                            } else {
                                audio.addCommand('-c:a', "aac"); // Converts audio if in other format
                            }
                            let rawPath = "temp/" + generatedUuid + "-audio" + "-raw" + "." + audioFormat;
                            audio.save("./" + rawPath, async function (err, file) {
                                if (!err) {
                                    console.log('Audio file: ' + file);
                                    let audioObj = {
                                        "path" : rawPath,
                                        "detail" : "aac"
                                    }
                                    objUrls.push(audioObj)
                                    convertVideos(i, originalVideo, objUrls, generatedUuid, false, room, body);
                                } else {
                                    deleteVideoArray(objUrls, originalVideo, room);
                                    io.to(room).emit('uploadErr', "Something went wrong");
                                    console.log(err);
                                    return err;
                                }
                            });
                        } else {
                            deleteVideoArray(objUrls, originalVideo, room);
                            console.log("Audio codec not supported");
                            io.to(room).emit('uploadErr', "Audio codec not supported");
                        }
                    });
                } else {
                    process.then(async function (video) {
                        let rawPath = "temp/" + generatedUuid + "-" + resolutions[i] + "-raw" + "." + format;
                        video.setVideoSize(resolutions[i] + "x?", true, true).setDisableAudio();
                        video.addCommand('-x264-params', 'keyint=24:min-keyint=24:no-scenecut');
                        video.save("./" + rawPath, async function (err, file) {
                            if (!err) {
                                console.log('Video file: ' + file);
                                let videoObj = {
                                    "path" : rawPath,
                                    "detail" : resolutions[i]
                                };
                                objUrls.push(videoObj);
                                convertVideos(i+1, originalVideo, objUrls, generatedUuid, false, room, body);
                            } else {
                                deleteVideoArray(objUrls, originalVideo, room);
                                io.to(room).emit('uploadErr', "Conversion error");
                                console.log(err);
                                return err;
                            }
                        });
                    });
                }
            } catch (e) {
                console.log("Error msg: " + e.msg);
                deleteVideoArray(objUrls, originalVideo, room);
                io.to(room).emit('uploadErr', "Conversion error");
                return e;
            }
        } else {
            io.to(room).emit('uploadUpdate', "video conversion complete");
            makeMpd(objUrls, originalVideo, room, body, generatedUuid);
        }
        return objUrls;
    }

    router.post('/videoupload', uploadCheck.single('video'), async (req, res, next) => {
        // 1) Check video file to ensure that file is viable for encoding, gets file info of temporarily saved file. Uses path to determine if viable for ffmpeg conversion
        let objUrls = [];
        try {
            const body = req.body;
            let fileInfo = path.parse(req.file.filename);
            let originalVideo = './temp/' + fileInfo.name + fileInfo.ext;
            console.log("Original path: " + originalVideo);
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
                    let resolution = video.metadata.video.resolution.w;
                    let container = video.metadata.video.container.toLowerCase();
                    if (supportedContainers.indexOf(container) >= 0) {
                        // Run ffmpeg convert video to lower method as many times as there is a lower video resolution
                        // Determine what resolution to downgrade to
                        if (resolution >= 360) {
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
                                                        objUrls = await convertVideos(i, originalVideo, objUrls, generatedUuid, true, room, body);
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
    });

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

    // End of download functionality
    /**************************************************************************************/

    // Set cloudfront cookies
    const setCloudCookies = (req, res) => {
        const cookie = cloudFront.getSignedCookie({
            policy
        });
        res.cookie('CloudFront-Key-Pair-Id', cookie['CloudFront-Key-Pair-Id'], {
            //domain: '.minipost.app',
            maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
            path: '/',
            httpOnly: true,
        });

        res.cookie('CloudFront-Policy', cookie['CloudFront-Policy'], {
            //domain: '.minipost.app',
            maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
            path: '/',
            httpOnly: true,
        });

        res.cookie('CloudFront-Signature', cookie['CloudFront-Signature'], {
            //domain: '.minipost.app',
            maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
            path: '/',
            httpOnly: true,
        });
        res.send({ querystatus: 'video permissions received'});
    };

    const serveCloudFrontUrl = (mpd) => {
        if (mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)) {
            mpd = s3Cred.cdn.cloudFront1 + "/" + mpd.match(/([a-z0-9].*)\/([a-z0-9].*)/)[2];
        }
        return mpd;
    }

    // Login function
    const loginfunc = async (req, res, next) => {
        if (req.body.email && req.body.password) {
            User.authenticate(req.body.email, req.body.password, function (error, user) {
                if (error || !user) {
                    var err = new Error('Wrong email or password');
                    err.status = 401;
                    err.type = "login error";
                    return next(err);
                } else {
                    req.session.userId = user._id;
                    req.session.username = user.username;
                    let options = {
                        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
                        signed: true,
                    }
                    if (req.cookies.loggedIn === undefined) {
                        (res.cookie('loggedIn', user.username, [options]));
                    }
                    return res.json({querystatus: "loggedin"});
                }
            });
        } else {
            var err = new Error('Email and password are required');
            err.status = 401;
            err.type = "login error";
            return next(err);
        }
    };

    const registerfunc = (req, res, next) => {
        if (req.body.username && req.body.regemail && req.body.regpassword && req.body.confirmPassword) {
            // confirm that user typed same password twice
            if (req.body.regpassword !== req.body.confirmPassword) {
                var err = new Error('Passwords do not match');
                err.status = 400;
                err.type = 'register error';
                return next(err);
            }

            // create obj with form input
            var userData = {
                email: req.body.regemail,
                username: req.body.username,
                password: req.body.regpassword,
                watching: '',
                friends: [
                    {
                        confirmed: [

                        ]
                    },
                    {
                        pending: [

                        ]
                    }
                ],
                videos: [],
                chats: [
                    {
                        confirmed: [

                        ]
                    },
                    {
                        pending: [

                        ]
                    }
                ],
            };

            User.findOne({username: req.body.username }, function(err, result) { // Search for entered user to see if user already exists
                console.log("Attempt register, use exists already?: " + result);
                console.log("Length of username: " + req.body.username.length);
                if (req.body.username.length < 23 && req.body.username.length > 4) {
                    if (result == null) { // if null, user does not exist
                        User.findOne({email: req.body.regemail }, function(err, result) { // Search for entered email to see if email exists
                            if (result == null) { // if null email does not exist
                                User.create(userData, function (error, user) { // Use schema's 'create' method to insert document into Mongo
                                    if (error) {
                                        var err = new Error('Error creating user using schema after email & user check');
                                        err.status = 401;
                                        err.type = 'register error';
                                        return next(error);
                                    } else {
                                        console.log(user);
                                        req.session.userId = user._id;
                                        req.session.username = user.username;
                                        let options = {
                                            maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
                                            signed: true,
                                        }
                                        if (req.cookies.loggedIn === undefined) {
                                            (res.cookie('loggedIn', user.username, [options]));
                                        }
                                        return res.json({querystatus: "loggedin"});
                                    }
                                });
                            } else {
                                var err = new Error('Email already exists');
                                err.status = 401;
                                err.type = 'register error';
                                console.log(err);
                                return next(err);
                            }
                        }).lean();
                    } else {
                        var err = new Error('User already exists');
                        err.status = 401;
                        err.type = 'register error';
                        console.log(err);
                        return next(err);
                    }
                } else {
                    var err = new Error('Username must be be 5 to 22 characters long');
                    err.status = 400;
                    err.type = 'register error';
                    console.log(err);
                    return next(err);
                }
            }).lean();


        } else {
            var err = new Error('All fields required for account registration');
            err.status = 400;
            err.type = 'register error';
            return next(err);
        }
    };


    const logoutf = (req, res, next) => {
        console.log('/logout');
        if (req.session) {
            // delete session object
            req.session.destroy(function(err) {
                if(err) {
                    return next(err);
                } else {
                    res.clearCookie('connect.sid');
                    res.clearCookie('loggedIn');
                    return res.redirect('/');
                }
            });
        } else {
            return res.redirect('/');
        }
    }

    // Search users that match a specific query. If limit included then return more users in response up to defined limit.
    // Use "req.body.limit" for "Load more" functionality on search
    const searchusersf = (req, res, next) => {
        //    console.log(req.body.searchusers);
        let searchresults = [];
        if (!req.body.searchusers) {
            res.json({querystatus: 'empty friend search query'});
        } else {
            if(req.body.limit) { // This determines if there is a body length limit, meaning a request to see more users. This only occurs if user has already made a base search which is done in the else statement.
                User.find({username: new RegExp(req.body.searchusers) }, {username: 1, friends: 1} , function(err, result) {
                    if (err) throw err;
                    console.log("limitedsearch length: " + result.length + " / " + req.body.limit);
                    let resultlength = result.length; // Save length before result array is spliced for accurate comparison later
                    searchresults.push(result.splice(0,req.body.limit)); // Splices result into only 0 to limit, leaving rest in result.
                    if (resultlength > req.body.limit) {
                        searchresults.push({ moreusers: true }); // determines if there are more users to load if another request is made
                    } else {
                        searchresults.push({ moreusers: false });
                    }
                    if (err) throw err;
                    User.findOne({username: req.body.username }, {friends: 1}, function(err, result) { // Finds user and gets friends
                        if (err) throw err;
                        console.log(result);
                        searchresults.push(result.friends[1].pending) // Pushes pending
                        console.log(searchresults);
                        res.json(searchresults);
                    }).lean();
                }).lean();
            } else {
                // the following makes a query to the database for users matching the user search input and only returns the username and id. This is the first query which limits the return search to 10 users.
                User.find({username: new RegExp(req.body.searchusers) }, {username: 1, friends: 1} , function(err, result) {
                    if (err) throw err;
                    console.log("base search");
                    console.log(result.length)
                    searchresults.push(result.splice(0,10));
                    if (result.length > 10) { // If there are more users to load in the results
                        searchresults.push({ moreusers: true }); // Return 'more users' truthiness: There are more users to be loaded if the user wants to make another request
                    } else {
                        searchresults.push({ moreusers: false });
                    }

                    // Follow query gets pending friends list from logged in user and pushes it into array to determine if a searched user has asked to be friends.
                    User.findOne({username: req.body.username }, {friends: 1}, function(err, result) {
                        if (err) throw err;
                        searchresults.push(result.friends[1].pending)
                        console.log(searchresults);
                        res.json(searchresults);
                        res.end();
                    }).lean();
                }).lean();
            }
        }
    }

    const requestfriendshipf = (req, res, next) => {
        console.log(req.body.thetitleofsomeonewewanttobecloseto, req.body.username);
        if (!req.body.thetitleofsomeonewewanttobecloseto) {
            // stop if there is no information to query.
            res.json({querystatus: 'empty friend search query'});
        } else if (req.body.thetitleofsomeonewewanttobecloseto === req.body.username) {
            // prevent asking self for friend request on server side
            res.json({querystatus: 'cant send a friend request to yourself :/'});
        } else {
            console.log("hey");
            // function to make request and add user to pending list.
            let addusertopendinglist = function() {
                User.findOneAndUpdate({username: req.body.thetitleofsomeonewewanttobecloseto},
                                      {$push: { "friends.1.pending": [{ username: req.body.username}]}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log(result);
                    console.log("addusertopendinglist fired");
                    res.json(result);
                }).lean();
            }

            User.findOne({username: req.body.thetitleofsomeonewewanttobecloseto}, {friends: 1}, function(err, result) {
                //Auto add to pending list if pending list is empty.
                if (!result.friends[1].pending[0]) {
                    addusertopendinglist();
                } else {
                    // run for loop through list of pending users to see if user has already asked.
                    let listedpendingrequests = result.friends[1].pending;
                    function alreadyaskedtobefriends() {
                        for (var i = 0; i < listedpendingrequests.length; i++) {
                            console.log(listedpendingrequests[i].username);
                            if (listedpendingrequests[i].username === req.body.username) {
                                return true;
                            }
                            console.log("listedpendingrequests fired");
                        }
                    }
                    function alreadyFriends() {
                        for (let i = 0; i < result.friends[0].confirmed.length; i++) {
                            if (req.body.thetitleofsomeonewewanttobecloseto == result.friends[0].confirmed[i]) {
                                console.log(result.friends[0].confirmed[i]);
                                return true;
                            }
                        }
                    }
                    // if user does not exist in pending list, add user to list.
                    if (!alreadyaskedtobefriends()) {
                        if (!alreadyFriends()) {
                            addusertopendinglist();
                        } else {
                            res.json({querystatus: 'already friends'});
                        }
                    } else {
                        res.json({querystatus: 'already asked to be friends'});
                    }
                }
            }).lean();
        }
    }

    // the following route request either removes a friend from confirmed or pending list.
    // req.body.pending is a boolean, confirms if revoke pending request, otherwise it is a normal revoke friendship request
    const revokefriendshipf = (req, res, next) => {
        let resEnd = false;
        if (!req.body.thetitleofsomeoneiusedtowanttobecloseto) {
            // stop if there is no information to query.
            res.json({querystatus: 'empty friend revoke query'});
            resEnd = true;
        } else if (req.body.thetitleofsomeoneiusedtowanttobecloseto === req.body.username) {
            // prevent asking self for friend request on server side
            res.json({querystatus: 'cant stop being friends with yourself :/'});
            resEnd = true;
        } else {
            let stopbeingfriends = function() {
                User.findOneAndUpdate({username: req.body.thetitleofsomeoneiusedtowanttobecloseto},
                                      {$pull: { "friends.0.confirmed": { username: req.body.username}}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log(result)
                    User.findOneAndUpdate({username: req.body.username},
                                          {$pull: { "friends.0.confirmed": { username: req.body.thetitleofsomeoneiusedtowanttobecloseto}}},
                                          {new: true},
                                          function(err, result) {
                        if (err) throw err;
                        console.log(result)
                        console.log("stopbeingfriends()");
                        if (!resEnd) {
                            res.json(result.friends[0].confirmed);
                            resEnd = true;
                        }
                    }).lean();
                }).lean();
            }

            let removeselffrompendinglist = function() {
                User.findOneAndUpdate({username: req.body.thetitleofsomeoneiusedtowanttobecloseto},
                                      {$pull: { "friends.1.pending": { username: req.body.username}}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log("removeselffrompendinglist()");
                    console.log(result)
                    if (req.body.pending) { // if revoke pending post request, respond with confirmed friends list. Otherwise response will come from stopbeingfriends function
                        console.log("pending request " + req.body.pending);
                        User.findOne({username: req.body.username},
                                     function(err, result) {
                            res.json(result.friends[0].confirmed);
                            resEnd = true;
                        });
                    }
                }).lean();
            }

            let removeotherfromownpendinglist = function() {
                User.findOneAndUpdate({username: req.body.username},
                                      {$pull: { "friends.1.pending": { username: req.body.thetitleofsomeoneiusedtowanttobecloseto }}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log("removeotherfromownpendinglist()");
                    console.log(result)
                    console.log("pending request " + req.body.pending + " refused");
                    User.findOne({username: req.body.username}, function(err, result) {
                        if (err) throw err;
                        console.log("Resulting pending list of " + req.body.username + " " + result.friends[1]);
                        res.json(result.friends[0].confirmed);
                        resEnd = true;
                    }).lean();
                }).lean();
            }

            if (req.body.refuse) { // Refusing a request someone else sent TRUE
                console.log("refuse " + req.body.refuse);
                User.findOne({ username: req.body.username}, {friends: 1}, function(err, result) {
                    if (err) throw err;
                    if (result.friends[1].pending[0]) {
                        let otheruserpresent = function() { // Checks if the other requesting user is present in the users pending list. If this is true, down below this function it will remove that user from users own pending list.
                            for (let i = 0; i < result.friends[1].pending.length; i++) {
                                console.log(result.friends[1].pending[i]);
                                if (result.friends[1].pending[i].username == req.body.thetitleofsomeoneiusedtowanttobecloseto) {
                                    console.log("refuse friendship with " + result.friends[1].pending[i]);
                                    return true;
                                }
                            }
                        }

                        if (otheruserpresent()) {
                            removeotherfromownpendinglist();
                        }
                    } else {
                        res.json({querystatus: 'No pending friends to ignore/refuse'});
                        resEnd = true;
                    }
                }).lean();
            } else {
                // Standard stop being friends functionality. Determines if your own username is present in other users friends list. Puts this into "usernamepresentinconfirmedlist" function. If not true, youre not friends with the person. Do nothing. If true, stopbeingfriends() function is ran.
                User.findOne({username: req.body.thetitleofsomeoneiusedtowanttobecloseto }, {friends: 1}, function(err, result) {
                    console.log(req.body.thetitleofsomeoneiusedtowanttobecloseto, "pending? ", req.body.pending);
                    let higherpriorityran = false;
                    if (!req.body.pending) { // if pending request is not true, user is asking to revoke friendship with friend.
                        if (result.friends[0].confirmed[0]) { // Initial check if user has any friends, if true proceed
                            let listedconfirmedfriends = result.friends[0].confirmed;
                            function usernamepresentinconfirmedlist() { // determine if present in other users confirmed list.
                                for (var i = 0; i < listedconfirmedfriends.length; i++) {
                                    if (listedconfirmedfriends[i].username === req.body.username) {
                                        console.log(listedconfirmedfriends[i].username + req.body.username);
                                        return true;
                                    }
                                }
                                return false;
                            }
                            // if present remove self from friends confirmed list and friend from selfs confirmed list.
                            if (!usernamepresentinconfirmedlist()) { // if not present in confirmed list, not friends.
                                console.log('initial friendship check');
                                res.json({querystatus: req.body.thetitleofsomeoneiusedtowanttobecloseto + ' is not friends with you', querymsg: 'not friends'});
                                resEnd = true;
                            } else {
                                console.log('a friendship revoked');
                                stopbeingfriends();
                                higherpriorityran = true;
                            }

                        } else { // other user has no friends, no point in unfriending
                            res.json({querystatus: req.body.thetitleofsomeoneiusedtowanttobecloseto + ' has no friends, you cannot unfriend them'});
                            resEnd = true;
                        }
                    }

                    // Check to remove yourself from pending list regardless if other functions ran.
                    // determine if present in pending list of asked person.
                    console.log("First user in other users pending list " + result.friends[1].pending[0]);
                    console.log(result);
                    if (result.friends[1].pending[0]) {
                        let listedpendingrequests = result.friends[1].pending;
                        function alreadyaskedtobefriends() {
                            for (var i = 0; i < listedpendingrequests.length; i++) {
                                // console.log(listedpendingrequests[i].username + " on " + req.body.thetitleofsomeoneiusedtowanttobecloseto + "'s pending list");
                                if (listedpendingrequests[i].username === req.body.username) { // Finds out if user is on other users pending list
                                    return true;
                                }
                            }
                        }

                        // if present in other users pending list remove self from pending list of asked person.
                        if (alreadyaskedtobefriends()) {
                            console.log('friendship request cancelled');
                            removeselffrompendinglist();
                        } else if (!higherpriorityran) {
                            if (!resEnd) {
                                res.json({querystatus: 'not on other users pending list'});
                                resEnd = true;
                            }
                        }
                    } else {
                        if (!resEnd) {
                            res.json({querystatus: 'not on other users pending list'});
                            resEnd = true;
                        }
                    }
                }).lean()
            }
        }
    }

    // Retrieves pending requests in a simple way for signed in user or any username sent with requests.
    const pendingrequestsf = (req, res, next) => {
        // prevent request if username not present
        if (!req.body.username) {
            res.json({querystatus: 'empty username in query'});
        } else {
            // find one, respond with friends pending list
            User.findOne({username: req.body.username }, {friends: 1}, function(err, result) {
                if (err) throw err;
                console.log(result.friends[1].pending)
                res.json(result.friends[1].pending);
            }).lean();
        }
    }

    // Function to become friends. Adds users username to newfriend confirmed list and adds newfriend to users confirmed list if not already present.
    const acceptfriendrequestf = (req, res, next) => {
        console.log(req.body.username)
        console.log(req.body.newfriend)
        if (!req.body.newfriend) {
            res.json({querystatus: 'empty new friend in query'});
        } else if (!req.body.username) {
            res.json({querystatus: 'empty username in query'});
        } else {
            // AddToSet functionality in becomefriends() ensures that even if a user is already listed in another users confirmed list, a duplicate is not created. Therefore separate becomefriends() functions do not need to be built. It will update if value is not present.
            let becomefriends = function() {
                console.log(req.body.username + " and " + req.body.newfriend + " becoming friends");
                User.findOneAndUpdate({username: req.body.newfriend}, // Update new friends document.
                                      {$addToSet: { "friends.0.confirmed": { username: req.body.username}}},
                                      {upsert: true,
                                       new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log(result);
                    User.findOneAndUpdate({username: req.body.username}, // Update your own document.
                                          {$addToSet: { "friends.0.confirmed": { username: req.body.newfriend}}},
                                          {upsert: true,
                                           new: true},
                                          function(err, result) {
                        if (err) throw err;
                        let userfriendslist = result.friends[0].confirmed;
                        res.json(userfriendslist);
                    });
                }).lean();
            }

            let removeselffrompendinglist = function() { // Removes your name from other users pending list
                User.findOneAndUpdate({username: req.body.newfriend},
                                      {$pull: { "friends.1.pending": { username: req.body.username}}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log('removing self from other users pending list');
                    console.log(result)
                }).lean();
            }

            let removefriendfrompendinglist = function() { // Removes new friend from your pending list
                User.findOneAndUpdate({username: req.body.username},
                                      {$pull: { "friends.1.pending": { username: req.body.newfriend}}},
                                      {new: true},
                                      function(err, result) {
                    if (err) throw err;
                    console.log('removing friend from your pending list');
                    console.log(result)
                }).lean();
            }

            // Determines if already asked to be friends and removes new friend from your pending list.
            // If new friend present in your confirmed list already, it will return this entire function as false.
            function newfriendnotpresentinusernameconfirmedlist() {
                User.findOne({username: req.body.username }, {friends: 1}, function(err, result) {
                    // determine if new friend is present in pending list to clean up pending list.
                    if (result.friends[1].pending[0]) {
                        let listedpendingrequests = result.friends[1].pending;
                        function friendalreadyaskedtobefriends() {
                            for (var i = 0; i < listedpendingrequests.length; i++) {
                                console.log(listedpendingrequests[i].username);
                                if (listedpendingrequests[i].username === req.body.newfriend) {
                                    return true;
                                }
                            }
                        }

                        // if friend already asked to be friends, remove friend from pending list.
                        if (friendalreadyaskedtobefriends()) {
                            removefriendfrompendinglist();
                        }
                    }

                    // determine if username has atleast one friend.
                    if (result.friends[0].confirmed[0]) {
                        let listedconfirmedfriends = result.friends[0].confirmed;
                        // determine if newfriend already present in usernames confirmed list.
                        function usernamepresentinconfirmedlist() {
                            for (var i = 0; i < listedconfirmedfriends[i].username; i++) {
                                if (listedconfirmedfriends[i].username === req.body.newfriend) {
                                    console.log(listedconfirmedfriends[i].username, req.body.newfriend);
                                    return true;
                                }
                            }
                            return false;
                        }

                        if (usernamepresentinconfirmedlist()) {
                            console.log('new friend already in confirmed list');
                            return false;
                        } else {
                            console.log('new friend not in confirmed list');
                            return true;
                        }
                    }
                }).lean();
            }


            function usernamenotpresentinnewfriendsconfirmedlist() {
                User.findOne({username: req.body.newfriend }, {friends: 1}, function(err, result) {
                    // determine if present in pending list of asked person to clean up pending list.
                    if (result.friends[1].pending[0]) {
                        let listedpendingrequests = result.friends[1].pending;
                        function alreadyaskedtobefriends() {
                            for (var i = 0; i < listedpendingrequests.length; i++) {
                                console.log(listedpendingrequests[i].username);
                                if (listedpendingrequests[i].username === req.body.username) {
                                    return true;
                                }
                            }
                        }

                        // if present remove self from pending list of asked person.
                        if (alreadyaskedtobefriends()) {
                            removeselffrompendinglist();
                        }
                    }

                    // determine if newfriend has atleast one friend.
                    if (result.friends[0].confirmed[0]) {
                        let listedconfirmedfriends = result.friends[0].confirmed;
                        // determine if already present in friends confirmed list.
                        function usernamepresentinconfirmedlist() {
                            for (var i = 0; i < listedconfirmedfriends[i].username; i++) {
                                if (listedconfirmedfriends[i].username === req.body.username) {
                                    console.log(listedconfirmedfriends[i].username, req.body.username);
                                    return true;
                                }
                            }
                            return false;
                        }
                        // if present add self to friends confirmed list and friend to selfs confirmed list.
                        if (usernamepresentinconfirmedlist()) {
                            console.log('username already in friends confirmed list');
                            return false;
                        } else {
                            console.log('username not in friends confirmed list');
                            return true;
                        }
                    }
                }).lean();
            }

            // These two functions remove either user from pending lists and then determine if either user is
            // already present in other users confirmed list.
            // The frontend tries to prevent a user sending a request when one is waiting for them, but if two users can send eachother pending friend requests it will remove both users from both users pending lists.

            newfriendnotpresentinusernameconfirmedlist();
            usernamenotpresentinnewfriendsconfirmedlist();

            // AddToSet functionality in becomefriends() ensures that even if a user is already listed in another users confirmed list, a duplicate is not created. Therefore separate becomefriends() functions do not need to be built. It will update if value is not present.
            becomefriends();
        }
    }

    const getconversationlogsf = (req, res, next) => {
        User.findOne({username: req.body.username}, {chats: 1}, function(err, result) {
            if (err) throw err;
            console.log(result);

            let chatdata = [];
            let chatsArray = [];
            async function getChats() {
                if (result.chats[0]) {
                    for (let i = 0; i < result.chats[0].confirmed.length; i++) {
                        chatdata = await Chat.findOne({_id: result.chats[0].confirmed[i]}).lean();
                        if (chatdata) {
                            chatdata.pending = "false";
                            chatsArray.push(chatdata);
                        }
                    }
                }
                return chatsArray;
            }

            async function getPendingChats() {
                if (result.chats[1]) {
                    for (let i = 0; i < result.chats[1].pending.length; i++) {
                        let chatdata = new Map();
                        chatdata = await Chat.findOne({_id: result.chats[1].pending[i]}).lean();
                        if (chatdata) {
                            chatdata.pending = "true";
                            chatsArray.push(chatdata);
                        }
                    }
                }
                return chatsArray;
            }

            getChats().then(function(chatsArray) {
                getPendingChats().then(function(chatsArray) {
                    console.log(chatsArray + " final chat array");
                    res.json(chatsArray);
                });
            });
        }).lean();
    }

    //
    const getUserVideosf = (req, res, next) => {
        User.findOne({username: req.body.username}, {username: 1, videos: 1} , async function(err, result) {
            if (err) throw err;
            let pendingVideo = false;
            if (result) {
                for (let video of result.videos) {
                    if (video) {
                        if (video.state.toString().match(/([a-z0-9].*);processing/)) {
                            pendingVideo = true;
                            res.json({ querystatus: video.id + ";processing"  });
                            break;
                        } else if (video.state.toString().match(/([a-z0-9].*);awaitinginfo/)) {
                            if (!pendingVideo) {
                                let videoNeedsInfo = await Video.findOne({ _id: video.id }).lean();
                                pendingVideo = true;
                                res.json({ querystatus: serveCloudFrontUrl(videoNeedsInfo.mpd) + ";awaitinginfo" });
                            }
                        }
                    }
                }
            }
            if (!pendingVideo) {
                res.json({ querystatus: "no pending videos" });
            }
        }).lean();
    }

    const getfriendsf = (req, res, next) => {
        console.log(req.body.username);
        User.findOne({username: req.body.username}, {username: 1, friends: 1} , function(err, result) {
            if (err) throw err;
            let userfriendslist;
            if (result.friends) {
                userfriendslist = result.friends[0].confirmed;
            }
            res.json(userfriendslist);
        }).lean();
    }

    // Change functionality of this to redis first, mongo second
    const beginchatf = (req, res, next) => {
        console.log(req.body.username, req.body.chatwith, req.body.message);
        let booleans = [];
        let chatdata;
        let chatmessage = req.body.message;
        console.log(req.body.message)
        if (!req.body.chatwith) {
            console.log(req.body.chatwith);
            res.json({querystatus: 'The chatwith user is undefined' });
        } else {
            // determine if user is already friends with chatwith.
            async function getfriendsalready() {
                let friendsalreadydata = await User.findOne({username: req.body.username }, {friends: 1}).lean();
                // if user has one friend.
                if (friendsalreadydata.friends[0].confirmed[0]) {
                    let listedconfirmedfriends = friendsalreadydata.friends[0].confirmed;
                    // determine if 'chatwith' already present in usernames confirmed list.
                    for (var i = 0; i < listedconfirmedfriends.length; i++) {
                        if (listedconfirmedfriends[i].username === req.body.chatwith) {
                            booleans.push({ friends: true });
                            break;
                        } else if (i === listedconfirmedfriends.length - 1) {
                            console.log('single false friends');
                            booleans.push({ friends: false });
                            break;
                        }
                    }
                } else {
                    booleans.push({ friends: false });
                }
                return booleans;
            }

            // determine if chat exists between two users.
            async function getchatexists() {
                let chatexistsdata = await Chat.findOne( { $and: [ {users: req.body.username }, {users: req.body.chatwith }] }).lean();
                chatdata = false;
                if (chatexistsdata) {
                    chatdata = chatexistsdata;
                }
                return chatdata;
            }

            // finds out if chat id is on users confirmed or pending list or neither.
            async function getlistedchattruthiness() {
                let chatid;
                if (chatdata) {
                    let chatslistpre = await User.findOne({username: req.body.username }).lean();
                    let chatid = chatdata._id;
                    console.log(chatdata._id);

                    console.log(chatslistpre);

                    if (!chatslistpre.chats[0]) {
                        console.log('updating confirmed document for user' + req.body.username)
                        User.findOneAndUpdate({username: req.body.username},
                                              {$set: { "chats.0": {confirmed: []}}}, {upsert: true, new: true},
                                              function(err, result) {
                            console.log(result);
                        }).lean();
                    }
                    if (!chatslistpre.chats[1]) {
                        console.log('updating pending document for user');
                        User.findOneAndUpdate({username: req.body.username},
                                              {$set: { "chats.1": {pending: [] }}}, {upsert: true, new: true},
                                              function(err, result) {
                            console.log(result);
                        }).lean();
                    }

                    let chatslist = await User.findOne({username: req.body.username });

                    if (chatslist.chats[0].confirmed.indexOf(chatid) > -1) {
                        console.log('on confirmed list at index ' + chatslist.chats[0].confirmed.indexOf(chatid));
                        booleans.push({ chatlisted: 'confirmed' });
                    } else if (chatslist.chats[1].pending.indexOf(chatid) > -1) {
                        console.log('on pending list at index ' + chatslist.chats[1].pending.indexOf(chatid));
                        booleans.push({ chatlisted: 'pending' });
                    } else {
                        console.log('chat id not listed on user document');
                        booleans.push({ chatlisted: false });
                    }

                }
                return booleans;
            }

            getfriendsalready().then(function() {
                getchatexists().then(function() {
                    console.log(chatdata, 'chat data');
                    if (chatdata) {
                        booleans.push({ chatexists: true });
                    } else {
                        booleans.push({ chatexists: false });
                    }
                    return booleans;
                }).catch(error => {
                    console.log(error);
                }).then(async function() {
                    booleans = await getlistedchattruthiness();
                    console.log("booleans " + JSON.stringify(booleans[0]));
                    console.log("booleans " + JSON.stringify(booleans[1]));
                    console.log("booleans " + JSON.stringify(booleans[2]));
                    if (booleans[1].chatexists) { // Chat exists true
                        console.log("Friends? " + booleans[0].friends);
                        let chatinfo = {
                            author: req.body.username,
                            content: chatmessage,
                            timestamp: new Date().toLocaleString(),
                        }

                        if (booleans[2].chatlisted === 'pending') {
                            // Listed on pending list, but wants to send chat thus making it confirmed. Send chat message to already created chat in db
                            console.log('take off pending list');
                            console.log(chatdata._id)
                            User.findOneAndUpdate({username: req.body.username},
                                                  {$pull: { "chats.1.pending": chatdata._id}},
                                                  {upsert: true,
                                                   new: true},
                                                  function(err, result) {
                                if (err) throw err;
                                // add to confirmed
                                User.findOneAndUpdate({username: req.body.username},
                                                      {$push: { "chats.0.confirmed": chatdata._id}},
                                                      {upsert: true,
                                                       new: true},
                                                      function(err, result) {
                                    if (err) throw err;
                                    // send chat
                                    Chat.findOneAndUpdate({_id: chatdata._id},
                                                          {$push: { "log": chatinfo}},
                                                          {upsert: true,
                                                           new: true},
                                                          function(err, result) {
                                        if (err) throw err;
                                        res.json(result);
                                    }).lean();
                                }).lean();
                            }).lean();
                        } else if (booleans[2].chatlisted === 'confirmed') { // Chat is already created, listed as confirmed, send chat to db
                            Chat.findOneAndUpdate({_id: chatdata._id},
                                                  {$push: { "log": chatinfo}},
                                                  {upsert: true,
                                                   new: true},
                                                  function(err, result) {
                                if (err) throw err;
                                res.json(result);
                            }).lean();
                        } else {
                            // This logic will most likely never occur
                            res.json({querystatus: 'You don\'t belong to this chat'});
                        }

                    } else { // Chat doesnt exist, but still friends, start new chatlog with user as host.
                        console.log('chat doesnt exist');

                        let generateUuid = async (data) => {
                            let temp;
                            let uuidTaken;
                            do {
                                temp = uuidv4(); // create new uuid
                                console.log("temp " + temp);
                                uuidTaken = await Chat.findOne({_id: temp}).lean(); // check if uuid is taken
                                console.log("uuid taken? " + uuidTaken);
                            } while (uuidTaken); // if uuid is taken, run again and create new uuid
                            return temp;
                        }

                        generateUuid().then(function(temp) {
                            let chatinfo = {
                                _id: temp,
                                host: req.body.username,
                                users: [
                                    req.body.username, req.body.chatwith
                                ],
                                log: [
                                    {
                                        author: req.body.username,
                                        content: chatmessage, // chat to append
                                        timestamp: new Date().toLocaleString(),
                                    },
                                ]
                            };

                            Chat.create(chatinfo, function (error, chat) { // use schema's 'create' method to insert chat document into Mongo
                                if (error) {
                                    console.log('error creating new chat');
                                    return next(error);
                                } else {
                                    // add chat to users confirmed list.
                                    User.findOneAndUpdate({username: req.body.username}, {$addToSet: { "chats.0.confirmed": chat._id}}, {upsert: true, new: true}, function(err, result) {
                                        if (err) throw err;
                                        // add chat to chatwith pending list.
                                        if (booleans[0].friends) {
                                            User.findOneAndUpdate({username: req.body.chatwith}, {$addToSet: { "chats.0.confirmed": chat._id}}, {upsert: true, new: true}, function(err, result) {
                                                if (err) throw err;
                                                res.json(result);
                                            }).lean();
                                        } else {
                                            User.findOneAndUpdate({username: req.body.chatwith}, {$addToSet: { "chats.1.pending": chat._id}}, {upsert: true, new: true}, function(err, result) {
                                                if (err) throw err;
                                                res.json(result);
                                            }).lean();
                                        }
                                    }).lean();
                                }
                            });
                        });


                        // when users log in they will get all chats in their document.
                        // send chat and add chat to both users confirmed chats
                    }
                })
            })
        }
    }
    // LOGIN USING CREDENTIALS
    router.post('/login', (req, res, next) => {
        return loginfunc(req, res, next);
    });

    // ATTEMPT REGISTER
    router.post('/register', (req, res, next) => {
        return registerfunc(req, res, next);
    });

    // LOGOUT
    router.get('/logout', (req, res, next) => {
        return logoutf(req, res, next);
    });

    // SEARCH / GET USERS THAT MATCH THIS QUERY.
    router.post('/searchusers', (req, res, next) => {
        return searchusersf(req, res, next);
    });

    // REQUEST FRIENDSHIP
    router.post('/requestfriendship', (req, res, next) => {
        return requestfriendshipf(req, res, next);
    });

    // REVOKE FRIENDSHIP
    router.post('/revokefriendship', (req, res, next) => {
        return revokefriendshipf(req, res, next);
    });

    // GET PENDING REQUESTS
    router.post('/pendingrequests', (req, res, next) => {
        return pendingrequestsf(req, res, next);
    })

    // ACCEPT FRIEND REQUEST
    router.post('/acceptfriendrequest', (req, res, next) => {
        return acceptfriendrequestf(req, res, next);
    })

    // GET FRIENDS
    router.post('/getfriends', (req, res, next) => {
        return getfriendsf(req, res, next);
    });

    router.post('/getUserVideos', (req, res, next) => {
        return getUserVideosf(req, res, next);
    })

    router.post('/setCloudCookies', (req, res, next) => {
        return setCloudCookies(req, res, next);
    })

    // Gets chat logs

    // Reminder, pending doesnt mean not friend request, it means the other user has not responded to the chat thus confirming it.
    // Users can chat together and have a chat on their confirmed list but that doesnt mean they are friends.
    // Pending chats can be treated differently on the front end. (can be hidden, shown last, deleted, etc).

    router.post('/getconversationlogs', (req, res, next) => {
        return getconversationlogsf(req, res, next);
    });

    // Sends chat message to a chat document.
    // If friends, chat doesnt exist, then create chat, make chat confirmed for both
    // If friends, chat exists, forward chat message to chat document
    // If not friends, chat doesnt exist, then create chat make chat pending for other user
    // If not friends, chat exists, forward chat message to chat document, if chat in pending array take chat off pending, put into confirmed.
    router.post('/beginchat', (req, res, next) => {
        return beginchatf(req, res, next);
    });


    // take chat id and append it to users in chat in the database.

    // Socket.io. Build socket opening route to make chat "live" (Seperate this into another function);

    // GET a users profile

    // GET a video

    // POST & upload a video
    return router;
}

