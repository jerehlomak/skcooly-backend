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
    fundWallet
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

router.get('/wallet/:studentId', getStudentWallet);
router.post('/wallet/fund', fundWallet);

module.exports = router;
