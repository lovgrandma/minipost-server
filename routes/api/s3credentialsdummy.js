// This is what your s3credentials.js file should look like. Place in this same directory.
// Replace X's with appropriate credentials.

exports = module.exports = {
    awsConfig: {
        accessKeyId: 'XXXXXXXXXXXXXXXXXXX',
        secretAccessKey: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        region:'us-east-2',
        snsTopicArnId: 'arn:aws:sns:XXXXXXXXXX:XXXXXXXXXXX:XXXXXXXXXXXXXXX',
        roleArnId: 'arn:aws:iam::XXXXXXXXXXX:role/XXXXXXXXXXXXXXXX'
    },
    cloudFrontKeysPath: {
        public: "./routes/api/keys/rsa-XXXXXXXXXXXXXXX.pem",
        private: "./routes/api/keys/pk-XXXXXXXXXXXXXXXXXXX.pem"
    },
    cdn: {
        cloudFront1: "https://XXXXXXXXXXXXXXX.cloudfront.net"
    },
    neo: {
        address: "bolt://anaddress:aport",
        username: "XXXXXXXX",
        password: "XXXXXXXXXXXXXXX"
    }
};
