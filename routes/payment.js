const Stripe = require('stripe');
const cred = require('./api/s3credentials.js');
const testkey = cred.stripe.testkey;
const key = cred.stripe.key;
const stripe = Stripe(testkey);
const User = require('../models/user');

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
    console.log(user, user._id);
    let data = { client_secret: '', card: {}};
    // If the user does not have a payment customer id associated with them we need to create one
    if (!user.payment) {
        user.payment = await createOneStripeCustomer(); // The payment customer id was created.
        if (user.payment) {
            let newPaymentData = user.payment;
            console.log(user.payment, user.username);
            let newUser = await User.findOneAndUpdate({ username: user.username }, { payment: user.payment }, { new: true }).lean(); // Append this data to the user on mongo so that their username is associated with these credit cards
            console.log(newUser);
        }
    }
    const intent = await stripe.setupIntents.create({ // Setup intents with just created payment id
        customer: user.payment
    });
    if (intent && user.payment) {
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