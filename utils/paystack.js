/**
 * Paystack Production Client
 * Real HTTP integration for Paystack Hosted / Standard checkout
 * Docs: https://paystack.com/docs/api
 */
'use strict';

const axios = require('axios');
const crypto = require('crypto');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * Initialize a hosted payment transaction on Paystack
 */
async function initializePayment({
    secretKey,
    amount,
    email,
    reference,
    currency = 'NGN',
    callbackUrl,
    metadata = {}
}) {
    if (!secretKey) throw new Error('Paystack Secret Key is required');
    if (!amount || amount <= 0) throw new Error('Invalid payment amount');
    if (!email) throw new Error('Customer email is required');
    if (!reference) throw new Error('Payment reference is required');

    // Amount in kobo (Paystack requires integer kobo)
    const amountInKobo = Math.round(Number(amount) * 100);

    const payload = {
        email,
        amount: amountInKobo,
        reference,
        currency: currency.toUpperCase(),
        callback_url: callbackUrl,
        metadata: {
            ...metadata,
            custom_fields: metadata.custom_fields || []
        }
    };

    const response = await axios.post(`${PAYSTACK_BASE_URL}/transaction/initialize`, payload, {
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 20000
    });

    if (!response.data?.status || !response.data?.data?.authorization_url) {
        throw new Error(response.data?.message || 'Failed to initialize Paystack payment');
    }

    return {
        status: 'success',
        checkoutUrl: response.data.data.authorization_url,
        accessCode: response.data.data.access_code,
        reference: response.data.data.reference || reference
    };
}

/**
 * Verify a transaction using Paystack's transaction reference
 */
async function verifyPayment({ secretKey, reference }) {
    if (!secretKey) throw new Error('Paystack Secret Key is required');
    if (!reference) throw new Error('Payment reference is required for Paystack verification');

    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    const data = response.data?.data;
    const isSuccess = response.data?.status && data?.status === 'success';

    return {
        success: isSuccess,
        status: data?.status || 'failed',
        amount: data?.amount ? Number(data.amount) / 100 : 0, // convert back to Naira
        currency: data?.currency || 'NGN',
        reference: data?.reference || reference,
        gatewayResponse: data?.gateway_response,
        paidAt: data?.paid_at,
        channel: data?.channel,
        customer: {
            email: data?.customer?.email,
            id: data?.customer?.id,
            customerCode: data?.customer?.customer_code
        },
        metadata: data?.metadata || {},
        rawData: data
    };
}

/**
 * Verify Paystack Webhook Signature using HMAC-SHA512
 */
function verifyWebhookSignature({ rawBody, signature, secretKey }) {
    if (!signature || !secretKey || !rawBody) return false;
    const computed = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    return computed === signature;
}

/**
 * Test Paystack credentials validity without charging
 */
async function testCredentials(secretKey) {
    if (!secretKey) return { valid: false, message: 'Secret key is empty' };
    try {
        const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction?perPage=1`, {
            headers: { Authorization: `Bearer ${secretKey}` },
            timeout: 10000
        });
        if (response.data?.status) {
            return { valid: true, message: 'Paystack connection verified successfully' };
        }
        return { valid: false, message: response.data?.message || 'Paystack check returned false' };
    } catch (err) {
        return {
            valid: false,
            message: err.response?.data?.message || err.message || 'Invalid Paystack credentials'
        };
    }
}

module.exports = {
    initializePayment,
    verifyPayment,
    verifyWebhookSignature,
    testCredentials
};
