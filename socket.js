// Sockets routes
const redis = require('redis');
const rejson = require('redis-rejson');
const redisapp = require('./redis');
const bluebird = require('bluebird'); // Allows promisfying of redis calls, important for simplified returning key-values for redis calls
bluebird.promisifyAll(redis);
const redisclient = redisapp.redisclient;
const stringify = require('json-stringify-safe');
const express = require('express');
const router = express.Router();
const User = require('./models/user');
const Chat = require('./models/chat');
const lzw = require('./compression/lzw');

exports = module.exports = function(io){

    // Socket io
    // Test method to test if socket is successfully speaking with client
    let socket;

    let updateType = (socket, data) => {
        let promise = new Promise(function(resolve, reject) {
            let decom = lzw.decompress(data); // decompress data to check which room to send to.
            const regex = /([a-z0-9.]*);([^]*);(.*)/;
            if (decom) {
                io.to(decom.match(regex)[3]).emit('typing', data); // echo typing data back to room
                resolve("complete");
            } else {
                reject(new Error("String too complex to be decompressed for typing update"));
            }
        });
        promise.catch(error => console.log(error.message));
    }

    // Updates redis db with a single chat
    let sendChat = async (socket, data) => {
        // If redis chat returns null, check mongo for chat.
        // If mongo returns null run shortened "beginchat" method for redis
        // Add log and set created chat in redis
        // return chat to user
        console.log(data);
        let getChat = async (data) => {
            console.log("data " + data.id); // chat data has id, chatwith, message, and user
            let temp = await redisclient.getAsync(data.id);
            if (!temp) {
                // The only way this would fail is if somehow the chat was deleted after the user loaded up the page.
                // The application defaults to load from mongo on load. No chats should be deleted. Only hidden if a user is blocked
                temp = await Chat.findOne({_id: data.id}).lean();
            }
            temp = JSON.parse(temp);
            let chatinfo = {
                author: data.user,
                content: data.message,
                timestamp: new Date().toLocaleString(),
            }
            temp.log.push(chatinfo); // appends value to temporary chat object
            redisclient.set(data.id, JSON.stringify(temp));
            console.log(temp);
            console.log(temp.log.length);
            if ((temp.log.length)%100 == 0) { // update mongo every 100 logs, else socket will take from redis
                // If query finds a mongo conversation with this id, update the log
                // Will only fire once as this fires when a user sends a chat. If the chat length at that time of updates' remainder of X amount is 0, then update mongo. Copies whole redis log, does not push.
                if (await Chat.findOne({_id: data.id}).lean()) {
                    Chat.findOneAndUpdate({_id: temp._id }, {"log": temp.log}, { new: true }, function(err, result) {
                        console.log("Updated");
                    });
                }
            }
            chatinfo.id = data.id;
            io.to(data.id).emit('chat', chatinfo); // Send small chats back instead of entire chat object
        }

        getChat(data);
    }

    // Gets conversations from redis using socket rooms.
    // If redis call does not return a value, query mongo for chat based on room id. Set to redis key and query redis again
    // Parse into json and then return. Resolve as a promise and emit to user
    let fetchConvos = async (socket, data) => {
        // Take socket room ids and organize them into array to query redis and mongo
        result = mapper(socket.rooms);
        let roomsArr = [];
        result.forEach((room, index) => {
            if (room.toString().length > 20 ) { // if length of room id > 20 therefore not the default socket room id
                roomsArr.push(room);
            }
        });

        let getChat = async (room) => { // Attempt to get room from redis, if null, create one from mongo query.
            let temp = await redisclient.getAsync(room);
            if (!temp) {
                chat = await Chat.findOne({_id: room}).lean();
                // console.log(chat);
                redisclient.set(room, JSON.stringify(chat));
                temp = await redisclient.getAsync(room);
            }
            temp = await JSON.parse(temp);
            return temp;
        }

        let promises = roomsArr.map(room => {
            return new Promise((resolve, reject) => {
                resolve(getChat(room));
            })
        });

        let rooms = await Promise.all(promises);
        console.log("convos to return " + rooms);
        socket.emit("returnConvos", rooms); // emit back rooms joined
    }

    // mapper method
    let mapper = function(group) {
        group = Object.keys(group).map(function(key) {
            return group[key];
        });
        return group;
    }


    // On connection note connect, on disconnect note disconnect
    io.on("connection", socket => {
        console.log(socket.rooms);
        console.log("New client connected");
        // Successful receipt of data being emitted from client, consumed by server
        socket.on('join', function(room) {
            let joinRoom = new Promise((resolve, reject) => {
                resolve(socket.join(room));
            })
            joinRoom.then(() => {
                console.log(socket.rooms); // The socket id creates a default room and adds the room to the object list
                let objIterate = 0;
                let result = Object.keys(socket.rooms).map(function(key) {
                    return socket.rooms[key];
                });

                io.to(result[1]).emit("chat", "You are now in room " + room); // emit back to specific room
            });
        });

        socket.on('joinConvos', async function(obj) { // Sets users rooms based on conversations
            console.log("s: joinConvos");
            let rooms = obj.ids;
            let user = obj.user;
            let mongoConvos = await User.findOne({username: user }, { chats: 1 }).lean();
            console.log("mongo convo vvv");
            console.log(mongoConvos.chats);


            let result = await mapper(socket.rooms);
            for (let i = 0; i < rooms.length; i++) {
                let roomAdded = false;
                for (let j = 0; j < result.length; j++) {
                    if (rooms[i] == result[j]) {
                        roomAdded = true;
                    }
                }
                if (roomAdded) { // If room added already, take out of array of rooms to join socket to
                    rooms.splice(rooms[i]);
                }
            }

            for (let i = 0; i < mongoConvos.chats[0].confirmed.length; i++) { // get all confirmed chats
                let add = true;
                for (let j = 0; j < result.length; j++) {
                    if (mongoConvos.chats[0].confirmed[i] == rooms[j]) {
                        add = false;
                    }
                }
                if (add) {
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
                if (add) {
                    rooms.push(mongoConvos.chats[1].pending[i]);
                }
            }
            // Functionality for checking if conversation was deleted, leaves deleted room of socket session
            // Somewhat uneccesary for now as this is not implemented on client side. Should still work while user is connected to socket
            for (let i = 0; i < result.length; i++) {
                let leaveRoom = true;
                for (let j = 0; j < rooms.length; j++) {
                    if (result[i] == rooms[j]) {
                        leaveRoom = false;
                    }
                }
                if (leaveRoom && (i != 0)) { // leaves room if not present in rooms to join
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
            console.log(addedRooms);
            console.log(checkRooms);
            fetchConvos(socket, user); // Fetch convos method
        })

        socket.on('typing', (data) => {
            updateType(socket, data);
        })

        socket.on('sendChat', (data) => { // Updates redis db with new chat
            sendChat(socket, data);
        })

        socket.on('fetchConvos', (data) => { // Confirms convos joined and gets convos from redis
            fetchConvos(socket, data);
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
