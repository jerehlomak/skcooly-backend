const express = require('express');
const router = express.Router();

const {
    handlePaymentWebhook,
    handleFlutterwaveWebhook,
    handleMonnifyWebhook,
    handlePaystackWebhook
} = require('../controllers/webhook.controller');

// Dedicated webhook endpoints
router.post('/flutterwave', express.json({ type: 'application/json' }), handleFlutterwaveWebhook);
router.post('/paystack', express.json({ type: 'application/json' }), handlePaystackWebhook);
router.post('/monnify', express.json({ type: 'application/json' }), handleMonnifyWebhook);

// Generic / legacy fallback endpoint
router.post('/payment', express.json({ type: 'application/json' }), handlePaymentWebhook);

module.exports = router;
