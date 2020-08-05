/** Utility file utility.js
@version 0.1
@author Jesse Thompson, @ninjagecko @
Includes helper utility functions that abstract more complicated functionality for seemingly mundane operations

Original code for deepEquals, arraysEqual, objectsEqual, mapsEqual typedArraysEqual from stackoverflow user @ninjagecko
https://stackoverflow.com/questions/3115982/how-to-check-if-two-arrays-are-equal-with-javascript */

function deepEquals(a,b) {
    if (a instanceof Array && b instanceof Array)
        return arraysEqual(a,b);
    if (Object.getPrototypeOf(a)===Object.prototype && Object.getPrototypeOf(b)===Object.prototype)
        return objectsEqual(a,b);
    if (a instanceof Map && b instanceof Map)
        return mapsEqual(a,b);
    if (a instanceof Set && b instanceof Set)
        throw "Error: set equality by hashing not implemented."
    if ((a instanceof ArrayBuffer || ArrayBuffer.isView(a)) && (b instanceof ArrayBuffer || ArrayBuffer.isView(b)))
        return typedArraysEqual(a,b);
    return a==b;  // see note[1] -- IMPORTANT
}

function arraysEqual(a,b) {
    if (a.length!=b.length)
        return false;
    for(var i=0; i<a.length; i++)
        if (!deepEquals(a[i],b[i]))
            return false;
    return true;
}
function objectsEqual(a,b) {
    var aKeys = Object.getOwnPropertyNames(a);
    var bKeys = Object.getOwnPropertyNames(b);
    if (aKeys.length!=bKeys.length)
        return false;
    aKeys.sort();
    bKeys.sort();
    for(var i=0; i<aKeys.length; i++)
        if (aKeys[i]!=bKeys[i]) // keys must be strings
            return false;
    return deepEquals(aKeys.map(k=>a[k]), aKeys.map(k=>b[k]));
}
function mapsEqual(a,b) {
    if (a.size!=b.size)
        return false;
    var aPairs = Array.from(a);
    var bPairs = Array.from(b);
    aPairs.sort((x,y) => x[0]<y[0]);
    bPairs.sort((x,y) => x[0]<y[0]);
    for(var i=0; i<a.length; i++)
        if (!deepEquals(aPairs[i][0],bPairs[i][0]) || !deepEquals(aPairs[i][1],bPairs[i][1]))
            return false;
    return true;
}
function typedArraysEqual(a,b) {
    a = new Uint8Array(a);
    b = new Uint8Array(b);
    if (a.length != b.length)
        return false;
    for(var i=0; i<a.length; i++)
        if (a[i]!=b[i])
            return false;
    return true;
}

/** Fisher-Yates shuffle https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array */
function shuffleArray(array) {
  var currentIndex = array.length, temporaryValue, randomIndex;

  // While there remain elements to shuffle...
  while (0 !== currentIndex) {

    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }

  return array;
}

module.exports = { deepEquals: deepEquals,
                 shuffleArray: shuffleArray };
