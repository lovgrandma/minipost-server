// Sockets routes
const redis = require('redis');
const redisapp = require('./redis');
const redisclient = redisapp.redisclient;
const stringify = require('json-stringify-safe');

exports = module.exports = function(io){
    // Socket io
    // Test method to test if socket is successfully speaking with client
    let interval;
    let val = 0;
    let socket;

    const getApiAndEmit = async socket => {
        let ts = Date.now();
        let date_ob = new Date(ts); let date = date_ob.getDate(); let month = date_ob.getMonth() + 1; let year = date_ob.getFullYear(); let hour = date_ob.getHours(); let minute = date_ob.getMinutes(); let seconds = date_ob.getSeconds();
        let am = (hour => 12) ? "pm" : "am";
        // prints date & time in YYYY-MM-DD format
        socket.emit("FromAPI", "Socket io Time: " + year + "-" + month + "-" + date + " | " + (hour % 12) + ":" + minute + ":" + seconds + " " + am); // Emitting a new message. It will be consumed by the client
    }

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

        socket.on('joinConvos', async function(rooms) { // Sets users rooms based on conversations
            let result = await mapper(socket.rooms);
            for (let i = 0; i < rooms.length; i++) {
                let roomAdded = false;
                for (let j = 0; j < result.length; j++) {
                    if (rooms[i] == result[j]) {
                        roomAdded = true;
                    }
                }
                if (!roomAdded) {
                    socket.join(rooms[i]);
                }
            }

        })

        socket.on('fetchConvos', async () => { // Confirms convos joined and gets convos from redis
            result = mapper(socket.rooms);
            let blurb = "";
            result.forEach(function(room, index) {
                let string = room.toString();
                if (index == result.length) {
                    blurb = blurb.concat(room);
                } else {
                    blurb = blurb.concat(room + ", ");
                }
            })
            // working redis call
            redisclient.set('moo', 'lar', redis.print);
            redisclient.get('moo', function (error, result) {
                if (error) {
                    console.log(error);
                    throw error;
                }
                console.log('GET result ->' + result);
            });
            redisclient.del('moo');
            redisclient.get('moo', redis.print);
            // create working mongo call
            socket.emit("chat", "You are in rooms: " + blurb); // emit back rooms joined
        })


        socket.on("disconnect", () => {
            console.log("Client disconnected");
        });

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
