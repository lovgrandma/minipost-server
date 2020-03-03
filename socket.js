// File for sockets routes
exports = module.exports = function(io){
    // Socket io
    // Test method to test if socket is successfully speaking with client
    let interval;

    const getApiAndEmit = async socket => {
        let ts = Date.now();
        let date_ob = new Date(ts); let date = date_ob.getDate(); let month = date_ob.getMonth() + 1; let year = date_ob.getFullYear(); let hour = date_ob.getHours(); let minute = date_ob.getMinutes(); let seconds = date_ob.getSeconds();
        let am = (hour => 12) ? "pm" : "am";
        // prints date & time in YYYY-MM-DD format
        socket.emit("FromAPI", "Socket io Time: " + year + "-" + month + "-" + date + " | " + (hour % 12) + ":" + minute + ":" + seconds + " " + am); // Emitting a new message. It will be consumed by the client
    }

    // On connection note connect, on disconnect note disconnect
    io.on("connection", socket => {
        console.log("New client connected");
        // Ends last interval from old method instance and starts a new one
        if (interval) {
            clearInterval(interval);
        }
        interval = setInterval(() => getApiAndEmit(socket), 1000);

        socket.on("disconnect", () => {
            console.log("Client disconnected");
        });
    });
}
