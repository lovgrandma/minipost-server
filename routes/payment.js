const Stripe = require('stripe');
const cred = require('./api/s3credentials.js');
const testkey = cred.stripe.testkey;
const stripe = Stripe(testkey);

const createOneStripeCustomer = async () => {
    const customer = await stripe.customers.create();
    if (customer.id) {
        return customer.id;
    } else {
        return null;
    }
}

const sendIntentSetupToClient = async (id) => {
    const intent = await stripe.setupIntents.create({
        customer: id
    });
    return intent.client_secret;
}

module.exports = {
    createOneStripeCustomer: createOneStripeCustomer,
    sendIntentSetupToClient: sendIntentSetupToClient
}