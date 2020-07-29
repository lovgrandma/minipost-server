/** Neo4j file neo.js
@version 0.1
@author Jesse Thompson
Interfaces with neo4j architecture, updates and appends relationships with relevant data and calls recommendation algorithms
*/

const path = require('path');
const neo4j = require('neo4j-driver');
const driver = neo4j.driver("bolt://localhost", neo4j.auth.basic("neo4j", "neo4j"));
const uuidv4 = require('uuid/v4');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);

/* Simple neo4j query. Working and shows syntax of method. */
const returnFriends = async (user) => {
    /* The session can only have one open query at once. Ensure that you never have several queries running at the same time,
    this will crash nodejs. Use .then promise syntax for simplicity */
    const session = driver.session();
    try {
        const query = "match (n) return n";
        /* Await result if you wish to use result to make another query. This avoids pyramid callback function style programming */
        const result = await session.writeTransaction(tx =>
            tx.run(query)
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

module.exports = { returnFriends: returnFriends };
