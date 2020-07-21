/** Neo4j file neo.js
@version 0.1
@author Jesse Thompson
Interfaces with neo4j architecture, updates and appends relationships with relevant data and calls recommendation algorithms
*/

const path = require('path');
const neo4j = require('neo4j-driver');
const uuidv4 = require('uuid/v4');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
