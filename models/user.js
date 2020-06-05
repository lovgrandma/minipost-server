// schema file for new documents added via mongoose. Authentication & hash password.

const mongoose = require('mongoose');
let encryption = null;
const uuidv4 = require('uuid/v4');

// Basic user schema
// Schema is an object that defines the structure of any documents that will be stored in your MongoDB collection; it enables you to define types and validators for all of your data items.
const UserSchema = new mongoose.Schema({
    _id: { 
        type: String, 
        default: uuidv4, 
        required: true
    },
    active: {
        default: false,
    },
    email: {
        type: String,
        unique: true,
        required: true,
        trim: true
    },
    username: {
        type: String,
        unique: true,
        required: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
    },
    friends: {
        type: Array,
        required: true,
    },
    status: {
        type: String,
        default: 'offline',
        required: true,
    },
    videos: {
        type: Array,
        required: true,
    },
    avatarurl: {
        type: String,
    },
    chats: {
        type: Array,
        required: true,
    }
});

// authenticate input against database documents
// You pass callback as an argument so it can plug into the query inside the function to preserve the flow of the application.
UserSchema.statics.authenticate = function(email, password, callback) {
    User.findOne({email: email})
        .exec(function (error, user) {
            if (error) {
                return callback(error);
            } else if (!user) {
                var err = new Error('User does not exist.');
                err.status = 401;
                return callback(err);
            }
            encryption = require('../scripts/bcrypt/encryption.js'); // import bcrypt here as it causes errors when workers call this file to make db queuries
            encryption.bcrypt.compare(password, user.password, function(error, result) {
                if (result === true) {
                    return callback(null, user);
                } else {
                    return callback();
                }
            });
    });
};

// hash password before saving to database
UserSchema.pre('save', function(next) {
    // this refers to the object the user created in the signup form
    encryption = require('../scripts/bcrypt/encryption.js');
    encryption.bcrypt.hash(this.password, 10, (err, hash) => {
        if (err) {
            return next(err);
        }
        this.password = hash;
        next();
    });

});


// Mongoose automatically looks for a plural version of the model name defined below 'User'. So User automatically looks for "users" in the database and if that does not exist it makes a collection named 'users' and begins adding to it everytime the User.create function is ran. Pass the data in as a variable containing the value pairs. The next argument can be a function, e.g User.crate(Userdata, function(error, user) { console.log(user)})

// Model is an object that gives you easy access to a named collection, allowing you to query the collection and use the Schema to validate any documents you save to that collection. It is created by combining a Schema, a Connection, and a collection name.

var User = mongoose.model('User', UserSchema);
module.exports = User;
