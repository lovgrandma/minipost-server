// schema file for new user chatlogs added via mongoose.

const mongoose = require('mongoose');
const uuidv4 = require('uuid/v4');

const ChatSchema = new mongoose.Schema({
    _id: { 
        type: String, 
        default: uuidv4, 
        required: true
    },
    host: {
        type: String,
        required: true,
    },
    users: {
        type: Array,
        required: true,
    },
    log: {
        type: Array,
        required: true,
    }
});

// Act on entered user data if necessary before being entered into mongodb
ChatSchema.pre('save', function(next) {
    console.log(this); // this refers to the object the user created in the signup form
    next();
});

var Chat = mongoose.model('Chat', ChatSchema);
module.exports = Chat;
