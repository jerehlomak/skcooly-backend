const express = require('express');
const {
    getMessages, sendMessage, updateInvoiceDocumentStatus, getParentMessages, replyToMessage, markParentMessagesRead
} = require('../controllers/financeMessaging.controller');

const router = express.Router();

const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

const { disputeInvoice } = require('../controllers/financev2.controller');

const {
    getFinanceDashboard,
    getDashboardActivity,
    getFinanceSettings,
    updateFinanceSettings,
    getFeeDefinitions,
    createFeeDefinition,
    updateFeeDefinition,
    deleteFeeDefinition,
    getFeeRules,
    createFeeRule,
    updateFeeRule,
    deleteFeeRule,
    getStudentWallet,
    getFamilyWallet, getMyFamilyWallet,
    fundWallet,
    getBillsReport,
    getPaymentsReport,
    getItemsReport,
    getOutstandingReport,
    getExecutiveReportSummary,
    getPayrollReport,
    getIncomeExpenseReport,
    exportReportCsv,
    getFinanceCategories,
    createFinanceCategory,
    updateFinanceCategory,
    deleteFinanceCategory,
    // Ledger Records
    getLedgerRecords,
    createLedgerRecord,
    updateLedgerRecord,
    deleteLedgerRecord,
    getProfitLossReport,
    exportLedgerCsv
} = require('../controllers/financev2.controller');

router.use(authenticateUser);

router.get('/dashboard', getFinanceDashboard);
router.get('/dashboard/activity', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getDashboardActivity);

router.route('/settings')
    .get(getFinanceSettings)
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFinanceSettings);

router.route('/fees')
    .get(getFeeDefinitions)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createFeeDefinition);

router.route('/fees/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFeeDefinition)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteFeeDefinition);

router.route('/fee-rules')
    .get(getFeeRules)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createFeeRule);

router.route('/fee-rules/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFeeRule)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteFeeRule);

router.get('/wallet/:studentId', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getStudentWallet);

router.get('/wallet/family/:parentId', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getFamilyWallet);
router.get('/my-family-wallet', authorizePermissions('PARENT'), getMyFamilyWallet);

router.post('/wallet/fund', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), fundWallet);

router.route('/categories')
    .get(getFinanceCategories)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createFinanceCategory);

router.route('/categories/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFinanceCategory)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteFinanceCategory);

// Ledger Records (Income & Expenses)
router.route('/ledger')
    .get(getLedgerRecords)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createLedgerRecord);

router.get('/ledger/profit-loss', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getProfitLossReport);
router.get('/ledger/export/csv', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), exportLedgerCsv);

router.route('/ledger/:type/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateLedgerRecord)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteLedgerRecord);

// Reports
router.get('/reports/executive-summary', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getExecutiveReportSummary);
router.get('/reports/payroll', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getPayrollReport);
router.get('/reports/income-expense', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getIncomeExpenseReport);
router.get('/reports/bills', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getBillsReport);
router.get('/reports/payments', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getPaymentsReport);
router.get('/reports/items', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getItemsReport);
router.get('/reports/outstanding', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getOutstandingReport);
router.get('/reports/export/csv', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), exportReportCsv);


// ─── MESSAGING & NOTIFICATIONS (Phase 8) ───
router.route('/messages').get(authenticateUser, getMessages).post(authenticateUser, sendMessage);
router.route('/messages/parent').get(authenticateUser, getParentMessages).post(authenticateUser, replyToMessage);
router.route('/messages/parent/mark-read').put(authenticateUser, markParentMessagesRead);
router.route('/invoices/:id/document-status').patch(authenticateUser, updateInvoiceDocumentStatus);

router.route('/invoices/:id/dispute').post(authenticateUser, disputeInvoice);

module.exports = router;
