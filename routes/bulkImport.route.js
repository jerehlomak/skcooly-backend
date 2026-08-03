const express = require('express');
const router = express.Router();
const {
    downloadStaffTemplate,
    downloadStudentTemplate,
    downloadParentTemplate,
    bulkImportStaff,
    bulkImportStudents,
    bulkImportParents,
    downloadBillingTemplate,
    downloadPaymentTemplate,
    bulkImportBilling,
    bulkImportPayments,
} = require('../controllers/bulkImport.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Template downloads
router.get('/template/staff', authenticateUser, authorizePermissions('ADMIN'), downloadStaffTemplate);
router.get('/template/students', authenticateUser, authorizePermissions('ADMIN'), downloadStudentTemplate);
router.get('/template/parents', authenticateUser, authorizePermissions('ADMIN'), downloadParentTemplate);
router.get('/template/billing', authenticateUser, authorizePermissions('ADMIN'), downloadBillingTemplate);
router.get('/template/payments', authenticateUser, authorizePermissions('ADMIN'), downloadPaymentTemplate);

// Bulk import uploads
router.post('/staff', authenticateUser, authorizePermissions('ADMIN'), bulkImportStaff);
router.post('/students', authenticateUser, authorizePermissions('ADMIN'), bulkImportStudents);
router.post('/parents', authenticateUser, authorizePermissions('ADMIN'), bulkImportParents);
router.post('/billing', authenticateUser, authorizePermissions('ADMIN'), bulkImportBilling);
router.post('/payments', authenticateUser, authorizePermissions('ADMIN'), bulkImportPayments);

module.exports = router;
