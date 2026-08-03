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
    updateInvoice,
    resendInvoice,
    markInvoicePrinted,
    markReceiptPrinted,
    getPaymentTransactions,
    getReceipts,
    applyWalletToInvoice,
    getInvoicesForWalletAllocation,
    getActivePaymentMethods,
    recordManualPayment,
    // Phase 3
    getClassBillingSummary,
    getClassStudents,
    getStudentBillingProfile,
    generateAllInvoices,
    bulkGenerateInvoices,
    // Phase 4
    getFamilyBillingSummary,
    getFamilyBillingProfile,
    generateFamilyInvoice,
    sendFamilyInvoice,
    // Phase 8
    initializePaystackWalletDeposit,
    verifyPayment,
    // Multi-gateway engine
    initializeOnlinePayment,
    initializeWalletDeposit,
    testGatewayConnection,
    // Phase 9
    bulkSendInvoices,
    bulkMarkInvoicesPrinted,
    getBillingBroadsheet,
} = require('../controllers/financePayment.controller');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];


// Note: /webhook/paystack is mounted directly in app.js (BEFORE express.json())
// so it receives the raw Buffer for correct HMAC-SHA512 signature verification.

// ─── Authenticated routes ─────────────────────────────────────────────────────
router.use(authenticateUser);

// Payment Settings (admin only)
router.route('/payment-settings')
    .get(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), getPaymentSettings)
    .put(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), updatePaymentSettings);

router.post('/payment-settings/test-connection', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), testGatewayConnection);

// Active gateways (everyone)
router.get('/payment-settings/active-methods', getActivePaymentMethods);

// Bank Accounts
router.route('/bank-accounts')
    .get(getBankAccounts)
    .post(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), createBankAccount);

router.route('/bank-accounts/:id')
    .put(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), updateBankAccount)
    .delete(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), deleteBankAccount);

// Universal Online Payment Initializer (Multi-gateway: Flutterwave, Paystack, Monnify)
router.post('/pay/initialize', initializeOnlinePayment);
router.post('/pay/flutterwave', initializeOnlinePayment);
router.post('/pay/paystack', initializeOnlinePayment);
router.post('/pay/monnify', initializeOnlinePayment);

// Universal Wallet Top-up
router.post('/pay/wallet-deposit', initializeWalletDeposit);
router.post('/pay/paystack/wallet-deposit', initializeWalletDeposit);
router.post('/pay/flutterwave/wallet-deposit', initializeWalletDeposit);
router.post('/pay/monnify/wallet-deposit', initializeWalletDeposit);

// Payment verification (PaymentSuccess page)
router.get('/payment-verify', verifyPayment);

// Bank Transfer submission (any authenticated user – parents, staff)
router.post('/transfers', submitTransfer);

// Transfer admin review
router.get('/transfers', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getTransferSubmissions);
router.put('/transfers/:id/review', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),reviewTransfer);

// Invoices
router.route('/invoices')
    .get(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getInvoices)
    .post(authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),generateInvoice);

router.get('/invoices/:id', getInvoice);
router.put('/invoices/:id', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),updateInvoice);
router.post('/invoices/:id/send', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),resendInvoice);
router.post('/invoices/:id/print', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),markInvoicePrinted);
router.post('/invoices/:id/pay', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),recordManualPayment);

// Payment transactions / reconciliation
router.get('/transactions', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getPaymentTransactions);

// Receipts
router.get('/receipts', getReceipts);
router.post('/receipts/:id/print', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),markReceiptPrinted);

// Wallet application (Admins & Parents)
router.post('/wallet/apply', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF', 'PARENT'), applyWalletToInvoice);
router.get('/wallet/invoices', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF', 'PARENT'), getInvoicesForWalletAllocation);

// ─── Phase 3: Single Billing ──────────────────────────────────────────────────
router.get('/billing/classes',                          authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getClassBillingSummary);
router.get('/billing/classes/:classId/students',        authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getClassStudents);
router.get('/billing/student/:studentId/profile',       authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getStudentBillingProfile);
router.post('/billing/bulk-generate',                   authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),bulkGenerateInvoices);
router.post('/billing/generate-all',                    authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),generateAllInvoices);

// ─── Phase 9: Bulk Actions & Broadsheet ──────────────────────────────────────
router.post('/invoices/bulk-send',                      authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), bulkSendInvoices);
router.post('/invoices/bulk-print',                     authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), bulkMarkInvoicesPrinted);
router.get('/broadsheet',                               authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), getBillingBroadsheet);

// ─── Phase 4: Family Billing ──────────────────────────────────────────────────
router.get('/billing/families',                         authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getFamilyBillingSummary);
router.get('/billing/families/:parentId',               authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),getFamilyBillingProfile);
router.post('/billing/families/:parentId/invoice',      authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),generateFamilyInvoice);
router.post('/billing/families/:parentId/send',         authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'),sendFamilyInvoice);

module.exports = router;
