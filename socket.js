// Sockets routes
const redis = require('redis');
const redisapp = require('./redis');
const redisclient = redisapp.redisclient;
const stringify = require('json-stringify-safe');
const express = require('express');
const router = express.Router();
const User = require('./models/user');
const Chat = require('./models/chat');
const lzw = require('./scripts/compression/lzw');
const { get } = require('./routes/utility.js');
const neo = require('./routes/neo.js');

exports = module.exports = function(io){

    // Socket io
    // Test method to test if socket is successfully speaking with client
    let socket;

    // Updates typing data and emits typing to room. Typing only updates if username != user that sent message
    let updateType = (socket, data) => {
        try {
            let promise = new Promise(function(resolve, reject) {
                let decom = lzw.decompress(data); // decompress data to check which room to send to.
                const regex = /([a-z0-9.]*);([^]*);(.*)/;
                if (decom) {
                    io.to(decom.match(regex)[3]).emit('typing', data); // echo typing data back to room
                    resolve("complete");
                } else {
                    reject(new Error("data too complex to be decompressed for typing update"));
                }
            });
            promise.catch(error => console.log(error.message));
        } catch (err) {
            // something went wrong
        }
    }

    // If no convo on redis, create new, else append
    let getChatAndAppend = async (data) => { // chat data has id, chatwith, message, and user
        let temp = await redisclient.getAsync(data.id); 
        temp = await JSON.parse(temp);
        // If there is no chat between users, create one and set in redis. This is unlikely to happen as chats are created when user starts a chat with someone they have not created a chat with. Chat will still work regardless 
        // If chat is not confirmed for a user, will make call to do to add chat to "confirmed" on User record on mongo for that user
        if (!temp) { 
            temp = {
                id: data.id,
                users: [ data.user, data.chatwith ],
                log: [
                    {
                        author: data.user,
                        content: data.message,
                        timestamp: new Date().toLocaleString()
                    }
                ],
                host: data.user
            }
            redisclient.set(data.id, JSON.stringify(temp));
            chatinfo.id = data.id;
            io.to(data.id).emit('chat', chatinfo); // Send chat back to user
        } else { // Else just append
            let chatinfo = {
                author: data.user,
                content: data.message,
                timestamp: new Date().toLocaleString(),
            }
            let confirmed = false;
            temp.log.forEach((log) => {
                if (log.author == data.user) {
                    confirmed = true;
                }
            })
            if (!confirmed) {
                setUserRecordChatConfirmed(data.user, data.id); // Set chat to confirmed if no chats in convo matching user 
            }
            temp.log.push(chatinfo); // appends value to temporary chat object
            if (temp.log.length > 1000) { // If chat length is over 999, shorten first and ensure length stays under 1000
                temp.log.shift();
            }
            redisclient.set(data.id, JSON.stringify(temp));
            chatinfo.id = data.id;
            io.to(data.id).emit('chat', chatinfo); // Send chat back to user
        }
    }
    
    // When a user responds to a new conversation which they have no authored chats in, this will add the convo to their confirmed list on their mongo record
    let setUserRecordChatConfirmed = (user, chatid) => {
        User.findOneAndUpdate({username: user}, {$pull: { "chats.1.pending": chatid}}, {upsert: true, new: true}, function(err, result) {
            if (err) throw err;
            // add to confirmed
            User.findOneAndUpdate({username: user}, {$push: { "chats.0.confirmed": chatid}}, {upsert: true, new: true}, async function(err, result) {
                if (err) throw err;
            }).lean();
        }).lean();
    }
    
    // Updates redis db with a single chat
    let sendChat = async (socket, data) => {
        // If redis chat returns null, check mongo for chat.
        // If mongo returns null run shortened "beginchat" method for redis
        // Add log and set created chat in redis
        // return chat to user
        getChatAndAppend(data);
    }

    // Gets conversations from redis using socket rooms.
    // If redis call does not return a value, query mongo for chat based on room id. Set to redis key and query redis again
    // Parse into json and then return. Resolve as a promise and emit rooms to user
    let fetchConvos = async (socket, data) => { // data: String username of the user requesting their personal conversations

        // Take socket room ids and organize them into array to query redis and mongo
        result = mapper(socket.rooms);
        let roomsArr = [];

        /* Filter to ensure random default socket room id is not used for chat record keeping */
        result.forEach((room, index) => {
            if (room.toString().length > 20 ) { // if length of room id > 20 therefore not the default socket room id
                roomsArr.push(room);
            }
        });

        // Attempt to get room from redis, if null, create one from mongo query. Leave this. This is fine even though mongo chat functionality is depracated. The mongo record will have a perfect boilerplate to set new redis record
        let getChat = async (room) => {
            if (redisclient) {
                let temp = await redisclient.getAsync(room);
                if (!temp) {
                    chat = await Chat.findOne({_id: room}).lean();
                    redisclient.set(room, JSON.stringify(chat));
                    temp = await redisclient.getAsync(room);
                }
                temp = await JSON.parse(temp);
                return temp;
            }
        }

        let promises = roomsArr.map(room => {
            return new Promise((resolve, reject) => {
                resolve(getChat(room));
            })
        });

        let rooms = await Promise.all(promises);
        socket.emit("returnConvos", rooms); // emit back rooms joined
    }

    // data will look like: user:channel:followunfollow?
    let followChannel = async (socket, data) => {
        try {
            if (get(socket, 'rooms') && data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)) {
                if (mapper(socket.rooms) && data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[1] && data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[2] && data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[3]) {
                    const room = mapper(socket.rooms)[0];
                    // update neo4j and make redis call, return notifications from channel redis record. user channel subscribe
                    let user = data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[1];
                    let channel = data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[2];
                    let subscribe = data.match(/([a-zA-Z0-9].*);([a-zA-Z0-9].*);(true|false)/)[3];
                    // setFollows will return the channels the user is following in neo4j
                    let channels = await neo.setFollows(user, channel, subscribe).then( async (result) => {
                        return await neo.getChannelNotifications(result); // Returns notifications for all channels in result
                    });
                    socket.emit('returnNotif', channels);
                }
            }
        } catch (err) {
            // Something went wrong
        }
    }

    // Maps object and key's to array
    let mapper = function(group) {
        try {
            group = Object.keys(group).map(function(key) {
                return group[key];
            });
            return group;
        } catch (err) {
            return null;
        }
        return null;
    }


    // On connection note connect, on disconnect note disconnect
    io.on("connection", socket => {
        console.log("New client connected");
        // Successful receipt of data being emitted from client, consumed by server
        socket.on('join', function(room) {
            let joinRoom = new Promise((resolve, reject) => {
                resolve(socket.join(room));
            })
            joinRoom.then(() => {
                // console.log(socket.rooms); // The socket id creates a default room and adds the room to the object list
                let result = Object.keys(socket.rooms).map(function(key) {
                    return socket.rooms[key];
                });

                io.to(result[1]).emit("chat", "You are now in room " + room); // emit back to specific room
            });
        });

        socket.on('joinConvos', async function(obj) { // Sets users rooms based on conversations
            let rooms = obj.ids; // Rooms are initially set to rooms provided by user. These are rooms coming from their state, not necessarily rooms they are connected to
            let user = obj.user;
            let mongoConvos = await User.findOne({username: user }, { chats: 1 }).lean(); // Get any more potential convo id's from user
            if (mongoConvos) {
                let result = await mapper(socket.rooms); // Gets rooms user is currently in within the provided socket
                for (let i = 0; i < rooms.length; i++) {
                    let roomAdded = false;
                    for (let j = 0; j < result.length; j++) {
                        if (rooms[i] == result[j]) {
                            roomAdded = true;
                        }
                    }
                    if (roomAdded) { // If room added already, take out of array of rooms to join socket to
                        rooms.splice(rooms[i]); // Strange syntax. Should be splice(i, 1) ?? Leave for now
                    }
                }

                for (let i = 0; i < mongoConvos.chats[0].confirmed.length; i++) { // get all confirmed chats
                    let add = true;
                    for (let j = 0; j < result.length; j++) {
                        if (mongoConvos.chats[0].confirmed[i] == rooms[j]) {
                            add = false;
                        }
                    }
                    if (add) { // If mongo chat is not present in state rooms, push to
                        rooms.push(mongoConvos.chats[0].confirmed[i]);
                    }
                }

                for (let i = 0; i < mongoConvos.chats[1].pending.length; i++) { // get all pending chats
                    let add = true;
                    for (let j = 0; j < result.length; j++) {
                        if (mongoConvos.chats[1].pending[i] == rooms[j]) {
                            add = false;
                        }
                    }
                    if (add) { // If mongo pending chat is not present in state rooms, push to
                        rooms.push(mongoConvos.chats[1].pending[i]);
                    }
                }
                // Functionality for checking if conversation was deleted, leaves deleted room of socket session
                // Somewhat uneccesary for now as this is not implemented on client side. Should still work while user is connected to socket
                for (let i = 0; i < result.length; i++) {
                    let leaveRoom = true;
                    for (let j = 0; j < rooms.length; j++) {
                        if (result[i] == rooms[j]) {
                            leaveRoom = false; // Expecting a match. Match means this socket room is present in 
                        }
                    }
                    if (leaveRoom && (i != 0)) { // leaves room if not present in rooms to join. Means socket room is left over
                        socket.leave(result[i]);
                    }
                }

                // Creates promise to join user into rooms existing in rooms array
                let promises = rooms.map(room => {
                    return new Promise((resolve, reject) => {
                        socket.join(room, (err) => {
                            if(err) reject(err);
                            else resolve(room);
                        })
                    })
                })

                const reflect = p => p.then(v => ({v, status: "fulfilled" }), // Condition for determining truthiness of promise
                                            e => ({e, status: "rejected" }));
                // Returns the results of the promise to add socket to rooms
                let addedRooms = (await Promise.all(promises.map(reflect))).filter(o => o.status !== 'rejected').map(o => o.v);
                let checkRooms = Object.keys(socket.rooms); // Gets socket rooms These effectively will be the same excluding the main socket. Can check both of these variables in a console log.
                // log addedRooms and checkRooms to check for successfully added rooms
                fetchConvos(socket, user); // Fetch convos method
            }
        });

        socket.on('joinUploadSession', (data) => {
            let roomAdded = false;
            for (let i = 0; i < 3; i++) { // Try 3 times to add user to room
                if (!checkForRoom(data)) {
                    joinOneRoom(data);
                } else {
                    break;
                }
            }
        });

        let checkForRoom = (data) => { // Checks to see if specific room has been added
            for (room of Object.keys(socket.rooms)) {
                if (room == data) return true;
            }
            return false;
        }

        let joinOneRoom = (room) => { // Add user to specific room
            socket.join(room);
        }
        
        let requestTogetherSession = (socket, data) => {
            io.to(data.room).emit('promptTogether', data);
        }

        socket.on('typing', (data) => {
            updateType(socket, data);
        })

        socket.on('sendChat', (data) => { // Updates redis db with new chat
            sendChat(socket, data);
        })

        socket.on('fetchConvos', (data) => { // Confirms convos joined and gets convos from redis
            fetchConvos(socket, data);
        })

        socket.on('bump', (data) => {
            const bumpRegex = /([^]*);([^]*);([^]*);(.*)/; // regex for reading 'bump' emits
            let room = data.match(bumpRegex)[4];
            io.to(room).emit('bump', data);
        })
        
        socket.on('requestTogetherSession', (data) => {
            requestTogetherSession(socket, data);
        })
        
        socket.on('sendConfirmTogether', (data) => {
            io.to(data.room).emit('confirmTogether', data);
        })
        
        socket.on('marcoCheck', (data) => {
            io.to(data.room).emit('marco', data);
        })
        
        socket.on('poloCheck', (data) => {
            io.to(data.room).emit('polo', data);
        });

        socket.on('follow', (data) => {
            followChannel(socket, data);
        })
        
        socket.on('sendCloseTogetherSession', (data) => {
            io.to(data.room).emit('receiveCloseTogetherSession', data);
        })
        
        socket.on('sendWatch', (data) => {
            io.to(data.room).emit('receiveWatch', data);
        })

        socket.on("disconnect", () => { // Should update mongodb on every disconnect
            console.log("Client disconnected");
        });

    });

    io.on('reconnect_attempt', () => {
        socket.io.opts.transports = ['polling', 'websocket'];
    });
    // Client side
    // When user sends message, wait until socket is created and returns new chat before allowing another chat to be sent. (Spinner animation)
    // Unless nonfriends, users will not be able to communicate if sockets is not functioning or connecting session


    // user to socket
    // "chat" namespace, "socket id/chat uuid" room. Socket will retrieve chat from db if not already in a temporary redis store. Create temporary redis store for chat if not existing.
    // If there is a redis store it will access redis for chat info. Update redis on new chat message emits. Emit full chat back to clients of room.
    // Client sets most recent socket emit to state

    // socket to db
    // On disconnect append redis chat to db. Delete redis chat of this uuid.
    // Will make a query to the database to retrieve chat if no redis existing

    // 2. Socket queries redis
    // 3. Redis returns chat if chat exists, else redis queries mongo, then returns chat
    // 4. set chat to state

}
