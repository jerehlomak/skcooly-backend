/**
 * Monnify API Production Client
 * Real HTTP integration for Monnify payments (Card, Account Transfer, Dynamic Accounts)
 * Docs: https://teamapt.atlassian.net/wiki/spaces/MON/pages/212009026/Monnify+API+Documentation
 */
'use strict';

const axios = require('axios');
const crypto = require('crypto');

function getBaseUrl(env = 'TEST') {
    return env === 'LIVE'
        ? 'https://api.monnify.com'
        : 'https://sandbox.monnify.com';
}

/**
 * Obtain an OAuth2 Bearer Access Token from Monnify
 */
async function getAccessToken({ apiKey, secretKey, env = 'TEST' }) {
    if (!apiKey || !secretKey) throw new Error('Monnify API Key and Secret Key are required');

    const authHeader = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
    const baseUrl = getBaseUrl(env);

    const response = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, {
        headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    if (!response.data?.requestSuccessful || !response.data?.responseBody?.accessToken) {
        throw new Error(response.data?.responseMessage || 'Failed to authenticate with Monnify');
    }

    return response.data.responseBody.accessToken;
}

/**
 * Initialize a Monnify Hosted / Web checkout transaction
 */
async function initializePayment({
    apiKey,
    secretKey,
    contractCode,
    amount,
    email,
    name,
    paymentReference,
    currency = 'NGN',
    redirectUrl,
    paymentDescription = 'School Fee Payment',
    env = 'TEST'
}) {
    if (!contractCode) throw new Error('Monnify Contract Code is required');
    if (!amount || amount <= 0) throw new Error('Invalid payment amount');
    if (!paymentReference) throw new Error('Payment reference is required');

    const token = await getAccessToken({ apiKey, secretKey, env });
    const baseUrl = getBaseUrl(env);

    const payload = {
        amount: Number(amount),
        customerName: name || 'Valued Parent/Student',
        customerEmail: email,
        paymentReference,
        paymentDescription,
        currencyCode: currency.toUpperCase(),
        contractCode,
        redirectUrl,
        paymentMethods: ['CARD', 'ACCOUNT_TRANSFER']
    };

    const response = await axios.post(`${baseUrl}/api/v1/merchant/transactions/init-transaction`, payload, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 20000
    });

    const body = response.data?.responseBody;
    if (!response.data?.requestSuccessful || !body?.checkoutUrl) {
        throw new Error(response.data?.responseMessage || 'Failed to initialize Monnify transaction');
    }

    return {
        status: 'success',
        checkoutUrl: body.checkoutUrl,
        reference: paymentReference,
        transactionReference: body.transactionReference,
        authorizedAmount: body.authorizedAmount
    };
}

/**
 * Query / Verify transaction status from Monnify
 */
async function verifyPayment({ apiKey, secretKey, paymentReference, env = 'TEST' }) {
    if (!paymentReference) throw new Error('Payment reference is required for Monnify verification');

    const token = await getAccessToken({ apiKey, secretKey, env });
    const baseUrl = getBaseUrl(env);

    const response = await axios.get(
        `${baseUrl}/api/v1/merchant/transactions/query?paymentReference=${encodeURIComponent(paymentReference)}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );

    const body = response.data?.responseBody;
    const isPaid = response.data?.requestSuccessful && body?.paymentStatus === 'PAID';

    return {
        success: isPaid,
        status: body?.paymentStatus || 'FAILED',
        amount: body?.amountPaid ? Number(body.amountPaid) : 0,
        currency: body?.currencyCode || 'NGN',
        paymentReference: body?.paymentReference || paymentReference,
        transactionReference: body?.transactionReference,
        customer: {
            name: body?.customer?.name,
            email: body?.customer?.email
        },
        paymentMethod: body?.paymentMethod,
        paidOn: body?.paidOn,
        rawData: body
    };
}

/**
 * Verify Monnify Webhook Signature using HMAC-SHA512
 */
function verifyWebhookSignature({ rawBody, signature, secretKey }) {
    if (!signature || !secretKey || !rawBody) return false;
    const computed = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    return computed === signature;
}

/**
 * Test Monnify credentials validity without making a charge
 */
async function testCredentials({ apiKey, secretKey, env = 'TEST' }) {
    try {
        await getAccessToken({ apiKey, secretKey, env });
        return { valid: true, message: 'Monnify API credentials successfully validated' };
    } catch (err) {
        return {
            valid: false,
            message: err.response?.data?.responseMessage || err.message || 'Invalid Monnify credentials'
        };
    }
}

module.exports = {
    getAccessToken,
    initializePayment,
    verifyPayment,
    verifyWebhookSignature,
    testCredentials
};
