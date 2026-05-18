const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getFinanceDashboard,
    getFinanceSettings,
    updateFinanceSettings,
    getFeeDefinitions,
    createFeeDefinition,
    updateFeeDefinition,
    deleteFeeDefinition,
    getStudentWallet,
    getFamilyWallet,
    fundWallet,
    getBillsReport,
    getPaymentsReport,
    getItemsReport,
    getOutstandingReport,
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

router.route('/settings')
    .get(getFinanceSettings)
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFinanceSettings);

router.route('/fees')
    .get(getFeeDefinitions)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createFeeDefinition);

router.route('/fees/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateFeeDefinition)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteFeeDefinition);

router.get('/wallet/:studentId', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getStudentWallet);
router.get('/wallet/family/:parentId', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getFamilyWallet);
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
router.get('/reports/bills', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getBillsReport);
router.get('/reports/payments', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getPaymentsReport);
router.get('/reports/items', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getItemsReport);
router.get('/reports/outstanding', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getOutstandingReport);
router.get('/reports/export/csv', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), exportReportCsv);

module.exports = router;
