const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getPaymentSettings,
    updatePaymentSettings,
    getBankAccounts,
    createBankAccount,
    updateBankAccount,
    deleteBankAccount,
    initializePaystackPayment,
    handlePaystackWebhook,
    submitTransfer,
    reviewTransfer,
    getTransferSubmissions,
    generateInvoice,
    getInvoices,
    getInvoice,
    getPaymentTransactions,
    getReceipts,
    applyWalletToInvoice,
    getActivePaymentMethods,
} = require('../controllers/financePayment.controller');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];


// Note: /webhook/paystack is mounted directly in app.js (BEFORE express.json())
// so it receives the raw Buffer for correct HMAC-SHA512 signature verification.

// ─── Authenticated routes ─────────────────────────────────────────────────────
router.use(authenticateUser);

// Payment Settings (admin only)
router.route('/payment-settings')
    .get(authorizePermissions(...ADMIN_ROLES), getPaymentSettings)
    .put(authorizePermissions(...ADMIN_ROLES), updatePaymentSettings);

// Active gateways (everyone)
router.get('/payment-settings/active-methods', getActivePaymentMethods);

// Bank Accounts
router.route('/bank-accounts')
    .get(getBankAccounts)
    .post(authorizePermissions(...ADMIN_ROLES), createBankAccount);

router.route('/bank-accounts/:id')
    .put(authorizePermissions(...ADMIN_ROLES), updateBankAccount)
    .delete(authorizePermissions(...ADMIN_ROLES), deleteBankAccount);

// Paystack payment init
router.post('/pay/paystack', initializePaystackPayment);

// Bank Transfer submission (any authenticated user – parents, staff)
router.post('/transfers', submitTransfer);

// Transfer admin review
router.get('/transfers', authorizePermissions(...ADMIN_ROLES), getTransferSubmissions);
router.put('/transfers/:id/review', authorizePermissions(...ADMIN_ROLES), reviewTransfer);

// Invoices
router.route('/invoices')
    .get(authorizePermissions(...ADMIN_ROLES), getInvoices)
    .post(authorizePermissions(...ADMIN_ROLES), generateInvoice);

router.get('/invoices/:id', getInvoice);

// Payment transactions / reconciliation
router.get('/transactions', authorizePermissions(...ADMIN_ROLES), getPaymentTransactions);

// Receipts
router.get('/receipts', getReceipts);

// Wallet application
router.post('/wallet/apply', authorizePermissions(...ADMIN_ROLES), applyWalletToInvoice);

module.exports = router;
