/** Queue maintenance queuemaintenance.js
@version 0.1
@author Jesse Thompson
Performs simple periodic reporting of internal backend systems
*/

// Cleans all completed and failed jobs every 5 minutes and reports queue information
let maintenance = async function(videoQueue) {
    setInterval(async () => {
        videoQueue.clean(0, 'completed');
        videoQueue.clean(0, 'failed');
//        console.log("Cleaning video queue " + new Date().toUTCString());
//        console.log(await videoQueue.getJobCounts());
    }, 300000);
}

exports.queueMaintenance = maintenance;
