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

    const getApiAndEmit = async socket => {
        let ts = Date.now();
        let date_ob = new Date(ts); let date = date_ob.getDate(); let month = date_ob.getMonth() + 1; let year = date_ob.getFullYear(); let hour = date_ob.getHours(); let minute = date_ob.getMinutes(); let seconds = date_ob.getSeconds();
        let am = (hour => 12) ? "pm" : "am";
        // prints date & time in YYYY-MM-DD format
        socket.emit("FromAPI", "Socket io Time: " + year + "-" + month + "-" + date + " | " + (hour % 12) + ":" + minute + ":" + seconds + " " + am); // Emitting a new message. It will be consumed by the client
        socket.emit("chat", "chat message data" + " " + val);
    }

    // On connection note connect, on disconnect note disconnect
    io.on("connection", socket => {
        console.log("New client connected");
        // Successful receipt of data being emitted from client, consumed by server
        socket.on("emit", (data) => {
            console.log(data + " " + (val+=1));
        });
        // Ends last interval from old method instance and starts a new one
        if (interval) {
            clearInterval(interval);
        }
        interval = setInterval(() => getApiAndEmit(socket), 10000); // Creates interval after being destroyed


        socket.on("disconnect", () => {
            console.log("Client disconnected");
        });
    });


    // Client side
    // When user sends message, wait until socket is created and returns new chat before allowing another chat to be sent. (Spinner animation)
    // Unless nonfriends, users will not be able to communicate if sockets is not functioning or connecting session.


    // user to socket
    // "chat" namespace, "socket id/chat uuid" room. Socket will retrieve chat from db if not already in a temporary redis store. Create temporary redis store for chat if not existing.
    // If there is a redis store it will access redis for chat info. Update redis on new chat message emits. Emit full chat back to clients of room.
    // Client sets most recent socket emit to state

    // socket to db
    // On disconnect append redis chat to db. Delete redis chat of this uuid.
    // Will make a query to the database to retrieve chat if no redis existing

}
