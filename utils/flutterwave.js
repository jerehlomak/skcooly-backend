/**
 * Flutterwave v3 Production Client
 * Real HTTP integration for School Fee Collections, Subscriptions & Transfers
 * Docs: https://developer.flutterwave.com/docs
 */
'use strict';

const axios = require('axios');
const crypto = require('crypto');

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';

/**
 * Initialize a hosted checkout payment on Flutterwave
 */
async function initializePayment(params = {}) {
    const secretKey = params.secretKey;
    const publicKey = params.publicKey;
    const amount = Number(params.amount);
    const email = params.email || params.customer?.email;
    const name = params.name || params.customer?.name || 'Valued Customer';
    const tx_ref = params.tx_ref || params.txRef || params.reference;
    const currency = (params.currency || 'NGN').toUpperCase();
    const redirect_url = params.redirect_url || params.redirectUrl;
    const meta = params.meta || {};
    const title = params.title || params.customizations?.title || 'School Payment';
    const description = params.description || params.customizations?.description || 'Fee Payment';
    const logo = params.logo || params.customizations?.logo || '';

    if (!secretKey) throw new Error('Flutterwave Secret Key is required');
    if (!amount || amount <= 0) throw new Error('Invalid payment amount');
    if (!email) throw new Error('Customer email is required');
    if (!tx_ref) throw new Error('Transaction reference (tx_ref) is required');

    const payload = {
        tx_ref,
        amount,
        currency,
        redirect_url,
        payment_options: 'card,banktransfer,ussd,account',
        customer: {
            email,
            name
        },
        customizations: {
            title,
            description,
            ...(logo && { logo })
        },
        meta: {
            ...meta,
            initiated_at: new Date().toISOString()
        }
    };

    // Determine auth token (standard FLWSECK key or OAuth2 bearer if clientId provided)
    let authBearer = secretKey.trim();
    if (publicKey && !secretKey.startsWith('FLWSECK')) {
        try {
            const tokenRes = await axios.post(
                'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
                new URLSearchParams({
                    client_id: publicKey.trim(),
                    client_secret: secretKey.trim(),
                    grant_type: 'client_credentials'
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 10000
                }
            );
            if (tokenRes.data?.access_token) {
                authBearer = tokenRes.data.access_token;
            }
        } catch (oauthErr) {
            // fallback to direct secretKey
        }
    }

    try {
        const response = await axios.post(`${FLW_BASE_URL}/payments`, payload, {
            headers: {
                Authorization: `Bearer ${authBearer}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        if (response.data?.status !== 'success' || !response.data?.data?.link) {
            throw new Error(response.data?.message || 'Failed to initialize Flutterwave payment link');
        }

        return {
            status: 'success',
            message: 'Payment link generated',
            checkoutUrl: response.data.data.link,
            authorizationUrl: response.data.data.link,
            link: response.data.data.link,
            reference: tx_ref
        };
    } catch (err) {
        if (err.response?.status === 401) {
            throw new Error('Flutterwave authorization failed (401). Please ensure you have saved your standard Flutterwave Secret Key (starts with FLWSECK_TEST- or FLWSECK-) in Payment Settings.');
        }
        const errorMsg = err.response?.data?.message || err.message || 'Flutterwave payment initialization failed';
        throw new Error(errorMsg);
    }
}

/**
 * Verify a transaction using Flutterwave's transaction ID or reference
 */
async function verifyPayment({ secretKey, transactionId, tx_ref }) {
    if (!secretKey) throw new Error('Flutterwave Secret Key is required');

    let endpoint = '';
    if (transactionId) {
        endpoint = `${FLW_BASE_URL}/transactions/${transactionId}/verify`;
    } else if (tx_ref) {
        endpoint = `${FLW_BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`;
    } else {
        throw new Error('Either transactionId or tx_ref is required for Flutterwave verification');
    }

    const response = await axios.get(endpoint, {
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    const data = response.data?.data;
    const isSuccessful = response.data?.status === 'success' && data?.status === 'successful';

    return {
        success: isSuccessful,
        status: data?.status || 'failed',
        amount: data?.amount ? Number(data.amount) : 0,
        currency: data?.currency || 'NGN',
        tx_ref: data?.tx_ref || tx_ref,
        flw_ref: data?.flw_ref,
        transactionId: data?.id,
        customer: {
            email: data?.customer?.email,
            name: data?.customer?.name,
            phone: data?.customer?.phone_number
        },
        meta: data?.meta || {},
        rawData: data
    };
}

/**
 * Verify Flutterwave Webhook Hash
 */
function verifyWebhookSignature(reqHeaders, expectedSecretHash) {
    if (!expectedSecretHash) return false;
    const headerHash = reqHeaders['verif-hash'] || reqHeaders['verification-hash'];
    if (!headerHash) return false;
    return headerHash === expectedSecretHash;
}

/**
 * Test credentials validity against Flutterwave without making a charge
 */
async function testCredentials(secretKey, publicKey) {
    if (!secretKey) return { valid: false, message: 'Secret key is empty' };

    // 1. If public key / Client ID is provided, try OAuth2 verification (v4 Developer Sandbox)
    if (publicKey) {
        try {
            const tokenRes = await axios.post(
                'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
                new URLSearchParams({
                    client_id: publicKey.trim(),
                    client_secret: secretKey.trim(),
                    grant_type: 'client_credentials'
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 10000
                }
            );
            if (tokenRes.data?.access_token) {
                return { valid: true, message: 'Flutterwave Sandbox connection verified successfully via OAuth2!' };
            }
        } catch (oauthErr) {
            // If OAuth fails, proceed to try classic Bearer API authentication below
        }
    }

    // 2. Try classic v3 authentication
    try {
        const response = await axios.get(`${FLW_BASE_URL}/transactions?page=1`, {
            headers: { Authorization: `Bearer ${secretKey.trim()}` },
            timeout: 10000
        });
        if (response.data?.status === 'success') {
            return { valid: true, message: 'Flutterwave connection verified successfully!' };
        }
        return { valid: false, message: response.data?.message || 'Authentication check returned unconfirmed status' };
    } catch (err) {
        return {
            valid: false,
            message: err.response?.data?.message || err.message || 'Invalid Flutterwave credentials'
        };
    }
}

module.exports = {
    initializePayment,
    verifyPayment,
    verifyWebhookSignature,
    testCredentials
};
