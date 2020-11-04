// This is what your s3credentials.js file should look like. Place in this same directory.

exports = module.exports = {
    awsConfig: {
        accessKeyId: 'XXXXXXXXXXXXXXXXXXX',
        secretAccessKey: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        region:'us-east-2'
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
