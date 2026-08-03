const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const {
    getMyInvoices,
    getMyInvoice,
    getBillingProfile,
    updateBillingProfile,
    initializeSchoolInvoicePayment
} = require('../controllers/central.controller');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

router.use(authenticateUser);

router.get('/invoices', authorizePermissions(...ADMIN_ROLES), getMyInvoices);
router.get('/invoices/:id', authorizePermissions(...ADMIN_ROLES), getMyInvoice);
router.post('/invoices/:id/pay', authorizePermissions(...ADMIN_ROLES), initializeSchoolInvoicePayment);

router.route('/profile')
    .get(authorizePermissions(...ADMIN_ROLES), getBillingProfile)
    .put(authorizePermissions(...ADMIN_ROLES), updateBillingProfile);

module.exports = router;
