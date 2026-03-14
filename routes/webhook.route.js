const express = require('express')
const router = express.Router()

const { handlePaymentWebhook } = require('../controllers/webhook.controller')

// Webhook endpoint (must not use standard auth middleware to allow external providers)
router.post('/payment', express.json({ type: 'application/json' }), handlePaymentWebhook)

module.exports = router
