// schema file for new video metadata and link to url added via mongoose.
// How do upvotes work?
// If video uuid is listed in users "upvoted", on click upvote, remove upvote and reduce upvotes by 1
// if video uuid is not listed in upvoted, allow upvote and increase upvote of video by 1
// Same functionality with downvotes
// Downvote takes away from upvote and vice versa

const mongoose = require('mongoose');
const uuidv4 = require('uuid/v4');

const VideoSchema = new mongoose.Schema({
    _id: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: false,
    },
    description: {
        type: String,
        required: false,
    },
    tags: {
        type: Array,
        required: false,
    },
    mpd: {
        type: String,
        required: false,
    },
    locations: {
        type: Array,
        required: true,
    },
    author: { // author name will be username, not their uuid. To lower # of calls to mongo
        type: String,
        unique: false,
        required: true,
    },
    upvotes: { // upvote
        type: Number,
        required: true,
    },
    downvotes: {
        type: Number,
        required: true,
    },
    state: {
        type: String,
        required: true
    }
});

// Act on entered user data if necessary before being entered into mongodb
VideoSchema.pre('save', function(next) {
    next();
});

var Video = mongoose.model('Video', VideoSchema);
module.exports = Video;
