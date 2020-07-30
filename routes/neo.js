/** Neo4j file neo.js
@version 0.1
@author Jesse Thompson
Interfaces with neo4j architecture, updates and appends relationships with relevant data and calls recommendation algorithms
*/

const util = require('util');
const path = require('path');
const neo4j = require('neo4j-driver');
const driver = neo4j.driver("bolt://localhost", neo4j.auth.basic("neo4j", "neo4j"));
const uuidv4 = require('uuid/v4');
const User = require('../models/user');
const Chat = require('../models/chat');
const Video = require('../models/video');

/* Simple neo4j query. Working and shows syntax of method. */
const returnFriends = async () => {
    /* The session can only have one open query at once. Ensure that you never have several queries running at the same time,
    this will crash nodejs. Use .then promise syntax for simplicity */
    const session = driver.session();
    try {
        const query = "match (n) return n";
        /* Await result if you wish to use result to make another query. This avoids pyramid callback function style programming */
        const result = await session.writeTransaction
        (tx => tx.run(query)
            .then((result) => {
                /* Syntax for accessing records and record information.
                Always check to ensure that the record has a type of property before you assume it is there */
                result.records.forEach((record) => {
                    if (record._fields[0].properties.name) {
                        console.log(record._fields[0].properties.name);
                    }
                })
                return result;
            })
            .catch((err) => {
                console.log(err);
            })
        )

        console.log(result); // Result can be accessed here since this is async/await method being used properly.
    } catch (err) {
        console.log(err);
    }
}

/* Determines if friends listed in user document in mongodb are analogous to users' neo4j friend relationship edges */
const checkFriends = async (user) => {
    if (user && typeof user === 'string') {
        if (user.length > 0) {
            let userDoc = await User.findOne({username: user}).lean();
            if (userDoc) {
                const mongoFriends = userDoc.friends[0].confirmed;
                const session = driver.session();
                checkUserExists(user)
                .then(async(result) => {
                    console.log("User found: " + result);
                    if (!result) { // If user does not exist, add single new user to graph database
                        return await addOneUser(user);
                    }
                    return false;
                })
                .then(async (result) => {
                    console.log("addOneUser ran: " + result);
                    const query = "match (a:Person {username: $username })-[friends]-(b) return b";
                    session.run(query, {username: user })
                    .then(async (result) => {
                        session.close();
                        console.log(result.records);
                        const graphRecords = result.records;
                        if (graphRecords) {
                            let promises = mongoFriends.map(mongoRecord => {
                                return new Promise( async (resolve, reject) => {
                                    if (graphRecords.indexOf(mongoRecord.username) <= 0) {
                                        console.log(mongoRecord.username + " not found in graph records friends");
                                        let otherUser = await User.findOne({username: mongoRecord.username}).lean();
                                        if (otherUser) {
                                            let buildUser = await checkUserExists(mongoRecord.username)
                                            .then(async (result) => {
                                                if (!result) {
                                                    resolve(await addOneUser(mongoRecord.username));
                                                }
                                                resolve(true);
                                            })
                                        }
                                    }
                                })
                            })
                            await Promise.all(promises).then( async (result) => {
                                console.log(result);
                                console.log("3");
                            })
                        } else {
                            return false;
                        }

                    })
//                    .then(async (result) => {
//                        console.log(result);
//                        console.log("3");
//                    })
                })
            } else {
                return false;
            }
        }
    }
    return false;

}

const checkArrOfUsersExist = async (users) => {
    if (graphRecords.indexOf(mongoRecord.username) <= 0) {
        console.log(mongoRecord.username + " not found in graph records friends");
        let otherUser = await User.findOne({username: mongoRecord.username}).lean();
        if (otherUser) {
            let buildUser = await checkUserExists(mongoRecord.username)
            .then(async (result) => {
                if (!result) {
                    return await addOneUser(mongoRecord.username);
                }
                return true;
            })
        }
    }
}
/* Check if individual mongo user is represented in graph database */
const checkUserExists = async (user) => {
    console.log("1 " + user);
    if (user && typeof user === 'string') {
        if (user.length > 0) {
            let session = driver.session();
            let query = "match (a:Person {username: $username }) return a";
            const userFound = await session.run(query, {username: user })
                .then(async (result) => {
                    session.close();
                    if (result.records) {
                        if (result.records.length > 0) { // If one user was found matching said username
                            return true;
                        } else {
                            return false;
                        }
                    }
                })
            return userFound;
        }
    }
    return false;
}

/* Add one user to graph database */
const addOneUser = async (user) => {
    session = driver.session();
    query = "create (a:Person {name: $username, username: $username }) return a";
    const userAdded = session.run(query, {username: user })
        .then(async(result) => {
            session.close();
            if (result) {
                if (result.records[0]) {
                    console.log(result.records[0]._fields);
                    return true;
                }
            }
            return false;
        })
    return userAdded;
}

const addOneEdge = async (user, typeEdge, to) => {
    console.log(user, typeEdge, to);
    const query = ""

}

module.exports = { returnFriends: returnFriends,
                 checkFriends: checkFriends };
