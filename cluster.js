const cluster = require('cluster');

if (cluster.isMaster) {
    // Count the machine's CPUs
    let cpus = require('os').cpus().length;
    
    // Create a worker for each CPU
    for (let i = 0; i < cpus; i++) {
        cluster.fork();
    }
    
    // Listen for dying workers
    cluster.on('exit', function() {
        cluster.fork();
    })
} else {
    require('./app.js');
}