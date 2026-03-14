const express = require('express');
const router = express.Router();
const { initializePayment, handleWebhook, getInstallments } = require('../controllers/payment.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Webhook typically does not have standard authentication since it is triggered by Stripe/Gateway securely
router.post('/webhook/:gateway', express.raw({ type: 'application/json' }), handleWebhook);

// Protected routes
router.post('/initialize', authenticateUser, authorizePermissions('ADMIN', 'PARENT'), initializePayment);
router.get('/:invoiceId/installments', authenticateUser, getInstallments);

module.exports = router;
