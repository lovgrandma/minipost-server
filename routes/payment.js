const Stripe = require('stripe');
const cred = require('./api/s3credentials.js');
const testkey = cred.stripe.testkey;
const key = cred.stripe.key;
const stripe = Stripe(testkey);

// Creates a single customer. Only fires on a creation of a user account. Will not fire arbitrarily and flood Stripe database
const createOneStripeCustomer = async () => {
    const customer = await stripe.customers.create();
    if (customer.id) {
        return customer.id;
    } else {
        return null;
    }
}

// Send intent setup to client to allow for user to update sensitive data on frontend and prepare for Stripe
const sendIntentSetupToClient = async (user) => {
    let data = { client_secret: '', card: {}};
    const intent = await stripe.setupIntents.create({
        customer: user.id
    });
    if (intent) {
        if (intent.client_secret) {
            data.client_secret = intent.client_secret;
            data.user = user.payment;
            data.card = await stripe.paymentMethods.list({ customer: user.payment, type: 'card' });
            if (user.advertiser) {
                data.advertiser = user.advertiser;
            }
            return data;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

// The following method will take a payment method id and a customer id and then associate the two together on stripes servers
const attachCardCustomer = async (payment_id, cus_id) => {
    if (payment_id && cus_id) {
        return await stripe.paymentMethods.attach(
            payment_id, // PAYMENT_METHOD_ID
            {
                customer: cus_id, // CUSTOMER_ID
            }
        );
    } else {
        return false;
    }
}

module.exports = {
    createOneStripeCustomer: createOneStripeCustomer,
    sendIntentSetupToClient: sendIntentSetupToClient,
    attachCardCustomer: attachCardCustomer
}