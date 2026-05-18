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
    resendInvoice,
    getInvoices,
    getInvoice,
    getPaymentTransactions,
    getReceipts,
    applyWalletToInvoice,
    getActivePaymentMethods,
    recordManualPayment,
    // Phase 3
    getClassBillingSummary,
    getClassStudents,
    getStudentBillingProfile,
    bulkGenerateInvoices,
    // Phase 4
    getFamilyBillingSummary,
    getFamilyBillingProfile,
    sendFamilyInvoice,
    // Phase 8
    initializePaystackWalletDeposit,
    verifyPayment,
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
router.post('/pay/paystack/wallet-deposit', initializePaystackWalletDeposit);

// Payment verification (PaymentSuccess page)
router.get('/payment-verify', verifyPayment);

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
router.post('/invoices/:id/send', authorizePermissions(...ADMIN_ROLES), resendInvoice);
router.post('/invoices/:id/pay', authorizePermissions(...ADMIN_ROLES), recordManualPayment);

// Payment transactions / reconciliation
router.get('/transactions', authorizePermissions(...ADMIN_ROLES), getPaymentTransactions);

// Receipts
router.get('/receipts', getReceipts);

// Wallet application
router.post('/wallet/apply', authorizePermissions(...ADMIN_ROLES), applyWalletToInvoice);

// ─── Phase 3: Single Billing ──────────────────────────────────────────────────
router.get('/billing/classes',                          authorizePermissions(...ADMIN_ROLES), getClassBillingSummary);
router.get('/billing/classes/:classId/students',        authorizePermissions(...ADMIN_ROLES), getClassStudents);
router.get('/billing/student/:studentId/profile',       authorizePermissions(...ADMIN_ROLES), getStudentBillingProfile);
router.post('/billing/bulk-generate',                   authorizePermissions(...ADMIN_ROLES), bulkGenerateInvoices);

// ─── Phase 4: Family Billing ──────────────────────────────────────────────────
router.get('/billing/families',                         authorizePermissions(...ADMIN_ROLES), getFamilyBillingSummary);
router.get('/billing/families/:parentId',               authorizePermissions(...ADMIN_ROLES), getFamilyBillingProfile);
router.post('/billing/families/:parentId/send',         authorizePermissions(...ADMIN_ROLES), sendFamilyInvoice);

module.exports = router;

