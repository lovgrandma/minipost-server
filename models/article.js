// schema file for new user chatlogs added via mongoose.

const mongoose = require('mongoose');
const uuidv4 = require('uuid/v4');

const ArticleSchema = new mongoose.Schema({
    _id: {
        type: String,
        default: uuidv4,
        required: true
    },
    author: {
        type: String,
        required: true,
    },
    title: {
        type: String,
        required: true
    },
    running: {
        type: Array,
        required: true
    },
    body: {
        type: String,
        required: true,
    }
});

// Act on entered user data if necessary before being entered into mongodb
ArticleSchema.pre('save', function(next) {
    next();
});

var Article = mongoose.model('Article', ArticleSchema);
module.exports = Article;
