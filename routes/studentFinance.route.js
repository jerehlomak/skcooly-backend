const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getMyWallet,
    getMyInvoices,
    getMyPayments
} = require('../controllers/studentFinance.controller');

// All these routes require a logged-in user with role 'STUDENT'
router.use(authenticateUser);
router.use(authorizePermissions('STUDENT'));

router.get('/my-wallet', getMyWallet);
router.get('/my-invoices', getMyInvoices);
router.get('/my-payments', getMyPayments);

module.exports = router;
