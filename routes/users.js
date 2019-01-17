const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Chat = require('../models/chat');

//var today = new Date();
//var dd = today.getDate();
//var mm = today.getMonth()+1; //January is 0!
//var yyyy = today.getFullYear();
//
//if(dd<10) {
//    dd = '0'+dd
//} 
//
//if(mm<10) {
//    mm = '0'+mm
//} 
//
//today = mm + '/' + dd + '/' + yyyy;

// LOGIN

router.post('/login', (req, res, next) => {
    console.log('loginroute');
    if (req.body.email && req.body.password) {
        User.authenticate(req.body.email, req.body.password, function (error, user) {
            console.log(user);
            if (error || !user) {
                var err = new Error('Wrong email or password');
                err.status = 401;
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
                return res.redirect('/');
            }
        });
    } else {
        var err = new Error('Email and password are required');
        err.status = 401;
        return next(err);
    }
});

// REGISTER
router.post('/register', (req, res, next) => {
    if (req.body.username && req.body.regemail && req.body.regpassword && req.body.confirmPassword) {
        // confirm that user typed same password twice
        if (req.body.regpassword !== req.body.confirmPassword) {
            var err = new Error('Passwords do not match');
            err.status = 400;
            err.type = 'sign in error';
            console.log('sign in error');
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
            status: 'offline',
            chats: [],
        };
        
        // use schema's 'create' method to insert document into Mongo
        User.create(userData, function (error, user) {
            if (error) {
                console.log('error creating user using schema');
                return next(error);
            } else {
                console.log(user);
                req.session.userId = user._id;
                req.session.username = user.username;
                return res.redirect('/');
            }
        });
        
    } else {
        var err = new Error('All fields required for account registration');
        err.status = 400;
        return next(err);
    }
});

// LOGOUT

router.get('/logout', (req, res) => {
    console.log('/logout');
    if (req.session) {
        // delete session object
        req.session.destroy(function(err) {
            if(err) {
                return next(err);
            } else {
                res.clearCookie('connect.sid');
                return res.redirect('/');
            }
        });
    }
});

// @route GET users friends route 

router.get('/', (req, res) => {
    console.log('mainroute');
    User.find()
        .then(User => res.json(User))
});

// SEARCH / GET USERS THAT MATCH THIS QUERY.

router.post('/searchusers', (req, res, next) => {
//    console.log(req.body.searchusers);
    if (!req.body.searchusers) {
        res.json({querystatus: 'empty friend search query'});
    } else {
        // the following makes a query to the database for users matching the user search input and only returns the username and id.
        User.find({username: new RegExp(req.body.searchusers) }, {username: 1, friends: 1} , function(err, result) {
            if (err) throw err;
            let searchresults = [];
            searchresults.push(result);
                // gets pending friends list from logged in user and pushes it into array to determine if a searched user has asked to be friends.
                User.findOne({username: req.body.username }, {friends: 1}, function(err, result) {
                if (err) throw err;
//                console.log(result.friends[1].pending)
                searchresults.push(result.friends[1].pending)
                console.log(searchresults);
                res.json(searchresults);
                });
        });
    }
});

router.post('/requestfriendship', (req, res, next) => {
    console.log(req.body.thetitleofsomeonewewanttobecloseto, req.body.username);
    if (!req.body.thetitleofsomeonewewanttobecloseto) {
        // stop if there is no information to query.
        res.json({querystatus: 'empty friend search query'});
    } else if (req.body.thetitleofsomeonewewanttobecloseto === req.body.username) {
        // prevent asking self for friend request on server side
        res.json({querystatus: 'cant send a friend request to yourself :/'});
    } else {
        // function to make request and add user to pending list.
        let addusertopendinglist = function() {
            User.findOneAndUpdate({username: req.body.thetitleofsomeonewewanttobecloseto}, 
            {$push: { "friends.1.pending": [{ username: req.body.username}]}},
            {new: true}, 
            function(err, result) {
                if (err) throw err;
                console.log(result)
                res.json(result);
            });
        }
        
        User.findOne({username: req.body.thetitleofsomeonewewanttobecloseto }, {friends: 1}, function(err, result) {
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
                    }
                }
                // if user does not exist in pending list, add user to list.
                if (!alreadyaskedtobefriends()) {
                        addusertopendinglist();
                } else {
                    res.json({querystatus: 'already asked to be friends'});
                }
            }
        })
    }
});

router.post('/revokefriendship', (req, res, next) => {
    // the following route request either removes a friend from confirmed or pending list. 
    
    if (!req.body.thetitleofsomeoneiusedtowanttobecloseto) {
        // stop if there is no information to query.
        res.json({querystatus: 'empty friend revoke query'});
    } else if (req.body.thetitleofsomeoneiusedtowanttobecloseto === req.body.username) {
        // prevent asking self for friend request on server side
        res.json({querystatus: 'cant stop being friends with yourself :/'});
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
                    res.json(result);
                });
            });
        }
        
        let removeselffrompendinglist = function() {
            User.findOneAndUpdate({username: req.body.thetitleofsomeoneiusedtowanttobecloseto}, 
            {$pull: { "friends.1.pending": { username: req.body.username}}},
            {new: true}, 
            function(err, result) {
                if (err) throw err;
                console.log(result)
            });
        }
        
        User.findOne({username: req.body.thetitleofsomeoneiusedtowanttobecloseto }, {friends: 1}, function(err, result) {
            
            // determine if present in pending list of asked person.
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
                    console.log('friendship request cancelled');
                    removeselffrompendinglist();
                } 
            } else {
                res.json({querystatus: 'you are not friends with this person nor did you ask to be'});
            }    
            
            // determine if user has atleast one friend.
            if (result.friends[0].confirmed[0]) {
                let listedconfirmedfriends = result.friends[0].confirmed;
                // determine if present in friends confirmed list.
                function usernamepresentinconfirmedlist() {
                    for (var i = 0; i < listedconfirmedfriends[i].username; i++) {
                        if (listedconfirmedfriends[i].username === req.body.username) {
                            return false;
                        }
                    }
                }
                // if present remove self from friends confirmed list and friend from selfs confirmed list.
                if (!usernamepresentinconfirmedlist()) {
                    console.log('a friendship revoked');
                    stopbeingfriends();
                }
            }  
        })
    }
});

router.post('/pendingrequests', (req, res, next) => {
    // prevent request if username not present 
    if (!req.body.username) {
        res.json({querystatus: 'empty username in query'});
    } else {
        // find one, respond with friends pending list
        User.findOne({username: req.body.username }, {friends: 1}, function(err, result) {
            if (err) throw err;
            console.log(result.friends[1].pending)
            res.json(result.friends[1].pending);
        });
    } 
})

router.post('/acceptfriendrequest', (req, res, next) => {
    console.log(req.body.username)
    console.log(req.body.newfriend)
    if (!req.body.newfriend) {
        res.json({querystatus: 'empty new friend in query'});
    } else if (!req.body.username) {
        res.json({querystatus: 'empty username in query'});
    } else {
        // function to become friends. Adds username to newfriend confirmed list and adds newfriend to username confirmed list if not already present
        //AddToSet!!!!!!!
        let becomefriends = function() {
            User.findOneAndUpdate({username: req.body.newfriend}, 
            {$addToSet: { "friends.0.confirmed": { username: req.body.username}}},
            {upsert: true,
            new: true}, 
            function(err, result) {
                if (err) throw err;
                console.log(result)
                User.findOneAndUpdate({username: req.body.username}, 
                {$addToSet: { "friends.0.confirmed": { username: req.body.newfriend}}},
                {upsert: true,
                new: true}, 
                function(err, result) {
                    if (err) throw err;
                    let userfriendslist = result.friends[0].confirmed;
                    res.json(userfriendslist);
                });
            });
        }
        
        let removeselffrompendinglist = function() {
            User.findOneAndUpdate({username: req.body.newfriend}, 
            {$pull: { "friends.1.pending": { username: req.body.username}}},
            {new: true}, 
            function(err, result) {
                if (err) throw err;
                console.log('removing self from pending list');
                console.log(result)
            });
        }
        
        let removefriendfrompendinglist = function() {
            User.findOneAndUpdate({username: req.body.username}, 
            {$pull: { "friends.1.pending": { username: req.body.newfriend}}},
            {new: true}, 
            function(err, result) {
                if (err) throw err;
                console.log('removing friend from pending list');
                console.log(result)
            });
        }
        
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
                                return false;
                            }
                        }
                    }
                    // if present add self to friends confirmed list and friend to selfs confirmed list.
                    if (!usernamepresentinconfirmedlist()) {
                        console.log('new friend already in confirmed list');
                        return false;
                    }
                }  
            })
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
                                return false;
                            }
                        }
                    }
                    // if present add self to friends confirmed list and friend to selfs confirmed list.
                    if (!usernamepresentinconfirmedlist()) {
                        console.log('username already in friends confirmed list');
                        return false;
                    }
                }
            })
        }
        
        newfriendnotpresentinusernameconfirmedlist()
        usernamenotpresentinnewfriendsconfirmedlist()
        becomefriends();
        
        
    }
})

router.post('/getfriends', (req, res, next) => {
    User.findOne({username: req.body.username}, {username: 1, friends: 1} , function(err, result) {
        if (err) throw err;
        let userfriendslist = result.friends[0].confirmed;
//        console.log('getfriends' + userfriendslist);
        res.json(userfriendslist);
    })
});

// POST request. Conditional for starting new chat with user. 
// 1 Adds chatwith to pending IF chatwith is not friends else adds to confirmed. Adds pending chats to chatwith user if not friends
// 2 Takes chat message sent in request and sends to database
router.post('/getconversationlogs', (req, res, next) => {
    User.findOne({username: req.body.username}, {chats: 1}, function(err, result) {
        if (err) throw err;
        // make mongoose query for each chat id under user
        // put chatlog into list
        // put pending chats into another list
        for (var i = 0; i < result.chats[0].confirmed.length; i++) {
            
        }
        
        for (var i = 0; i < result.chats[0].pending.length; i++) {
            
        }
        return result;
    }).then(function(result) {
        
    })
})
            
router.post('/beginchat', (req, res, next) => {
    
    console.log(req.body.username, req.body.chatwith, req.body.chatmessage);
    let booleans = [];
    let chatdata;
    let chatmessage = 'fuck thats coca cola olympic ebola bipolah';

    // determine if user is already friends with chatwith.
    async function getfriendsalready() {
        let friendsalreadydata = await User.findOne({username: req.body.username }, {friends: 1});
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
        let chatexistsdata = await Chat.findOne( { $and: [ {users: req.body.username }, {users: req.body.chatwith }] });
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
            let chatslist = await User.findOne({username: req.body.username });
            let chatid = chatdata._id;
            console.log(chatdata._id);
            if (chatslist.chats[0].confirmed.indexOf(chatid)) {
                console.log('on confirmed list')
                booleans.push({ chatlisted: 'confirmed' });
            } else if (chatslist.chats[1].pending.indexOf(chatid)) {
                console.log('on pending list')  
                booleans.push({ chatlisted: 'pending' });
            }
        } else {
            console.log('chat id not listed on user document');
            booleans.push({ chatlisted: false });
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
        }).then(function() {
            getlistedchattruthiness().then(function(booleans) {
                console.log(booleans);
        }).catch(error => { 
            console.log(error);
        }).then(function() {
                if (booleans[0].friends) {
                    // if chat between users exists
                    if (booleans[1].chatexists) {
                        console.log('friends and chat exists');
                        let chatinfo = {
                                author: req.body.username,
                                content: chatmessage,
                                timestamp: new Date().toLocaleString(),
                            }
                        
                        if (booleans[2].chatlisted === 'pending') {
                            // take off pending list
                            // put on confirmed list
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
                                            });
                                        });
                                    });
                        } else if (booleans[2].chatlisted === 'confirmed') {
                            // send chat
                            Chat.findOneAndUpdate({_id: chatdata._id}, 
                            {$push: { "log": chatinfo}},
                            {upsert: true,
                            new: true}, 
                            function(err, result) {
                                if (err) throw err;
                                res.json(result);
                            });
                        }
                        
                    } else {
                        // start new chatlog with user as host.
                        console.log('friends and chat doesnt exist');
                    
                        var chatinfo = {
                        host: req.body.username,
                        users: [
                                req.body.username, req.body.chatwith
                            ],
                        log: [
                                {
                                    author: req.body.username,
                                    // append chat
                                    content: chatmessage,
                                    timestamp: new Date().toLocaleString(),
                                },
                            ]
                        };
                            
                        // use schema's 'create' method to insert document into Mongo
                        Chat.create(chatinfo, function (error, chat) {
                            if (error) {
                                console.log('error creating new chat');
                                return next(error);
                            } else {
                                // add chat to users confirmed list.
                                User.findOneAndUpdate({username: req.body.username}, 
                                {$addToSet: { "chats.0.confirmed": chat._id}},
                                {upsert: true,
                                new: true}, 
                                function(err, result) {
                                    if (err) throw err;
                                    // add chat to chatwith pending list.
                                    User.findOneAndUpdate({username: req.body.chatwith}, 
                                    {$addToSet: { "chats.1.confirmed": chat._id}},
                                    {upsert: true,
                                    new: true}, 
                                    function(err, result) {
                                        if (err) throw err;
                                        res.json(result);
                                    });
                                });
                            }
                        });       
                        
                        // when users log in they will get all chats in their document.
                        // send chat and add chat to both users confirmed chats
                    }
                } else {
                    // if not friends but chat between users exists
                    if (booleans[1].chatexists) {
                        let chatinfo = {
                                author: req.body.username,
                                content: chatmessage,
                                timestamp: new Date().toLocaleString(),
                            }
                        // if chat is on users confirmed list
                        if (booleans[2].chatlisted === 'confirmed') {
                            // send chat
                            Chat.findOneAndUpdate({_id: chatdata._id}, 
                                    {$push: { "log": chatinfo}},
                                    {upsert: true,
                                    new: true}, 
                                    function(err, result) {
                                        if (err) throw err;
                                        res.json(result);
                                    });
                        } else if (booleans[2].chatlisted === 'pending') {
                            // take chat off users pending list
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
                                            });
                                        });
                                    });
                        } else {
                            // you are not a part of this chat
                            // this logic most likely wont occur
                            res.json({querystatus: 'You don\'t belong to this chat' });
                        }
                    // Not friends & chat does not exist
                    } else {
                        console.log('not friends and chat doesnt exist');
                        // start new chatlog with user as host
                        var chatinfo = {
                        host: req.body.username,
                        users: [
                                req.body.username, req.body.chatwith
                            ],
                        log: [
                                {
                                    author: req.body.username,
                                    // append chat
                                    content: chatmessage,
                                    timestamp: new Date().toLocaleString(),
                                },
                            ]
                        };
                            
                        // use schema's 'create' method to insert document into Mongo
                        Chat.create(chatinfo, function (error, chat) {
                            if (error) {
                                console.log('error creating new chat');
                                return next(error);
                            } else {
                                // add chat to users confirmed list.
                                User.findOneAndUpdate({username: req.body.username}, 
                                {$addToSet: { "chats.0.confirmed": chat._id}},
                                {upsert: true,
                                new: true}, 
                                function(err, result) {
                                    if (err) throw err;
                                    // add chat to chatwith pending list.
                                    User.findOneAndUpdate({username: req.body.chatwith}, 
                                    {$addToSet: { "chats.1.pending": chat._id}},
                                    {upsert: true,
                                    new: true}, 
                                    function(err, result) {
                                        if (err) throw err;
                                        res.json(result);
                                    });
                                });
                            }
                        });
                        
                        
                        // when users log in they will get all chats in their document.
                        
                        
                    }
                }
            })
        })
    })
    
                
    
    
    // if chat is on pending list
    
    
    // if chat is on confirmed list
    
    
    
//    if (friendsalready) {
//        // friends
//        if (chatexists) {
//            // friends and chat exists. Send chat message to database
//            
//            // add chat to users active chats.
//        } else {
//            // friends but start new chatlog
//            // when other user logs in it will get all 
//            
//            // add chat to users active chats.
//        }
//    } else {
//        // not friends 
//        if (chatexists) {
//            // not friends but chatlog exists. 
//            if (onconfirmedlist) {
//                // send chat
//                // add chat to users active chats.
//            } else if (onpendinglist) {
//                // accept request to chat
//                // take off pending list and put into confirmed in chat
//                // send chat
//                // add chat to users active chats.
//            } else {
//                res.json({querystatus: 'you are not apart of this chat'});
//            }
//        } else {
//            // not friends & no chatlog 
//            var chatData = {
//                host: req.body.username,
//                users: [
//                    {
//                        confirmed: [
//                            req.body.username
//                    ]
//                    },
//                    {
//                        pending: [
//                            req.body.chatwith
//                        ]
//                    },
//                ],
//                log: [
//                    {
//                        host: req.body.username,
//                        content: 'this is a chat',
//                        timestamp: new Date().toLocaleString(),
//                    },
//                ]
//            };
//
//            // use schema's 'create' method to insert document into Mongo
//            Chat.create(chatData, function (error, chat) {
//                if (error) {
//                    console.log('error creating new chat');
//                    return next(error);
//                } else {
//                    return res.json(chat);
//                }
//            });
//            
//            // add chat to users active chats.
//            // put chat id into other users pending chats list.
//            
//        }
//    }

});

// confirm 

router.post('/confirmchat', (req, res, next) => {
    // confirms participation in chat by checking if user is in confirmed list, else adding user to confirmed and removing from pending
})

// send chat to database
router.post('/sendchat', (req, res, next) => {
    
    // put '/confirmchat' function here
    
    // sends message to database
    
})



// take chat id and append it to users in chat in the database.

// Socket.io. Build socket opening route to make chat "live" (Seperate this into another function);





// GET a users profile

// POST add friend

// DELETE friend

// GET a video

// POST & upload a video


module.exports = router;