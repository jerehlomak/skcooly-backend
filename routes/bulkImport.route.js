const express = require('express');
const router = express.Router();
const {
    downloadStaffTemplate,
    downloadStudentTemplate,
    bulkImportStaff,
    bulkImportStudents,
} = require('../controllers/bulkImport.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Template downloads
router.get('/template/staff', authenticateUser, authorizePermissions('ADMIN'), downloadStaffTemplate);
router.get('/template/students', authenticateUser, authorizePermissions('ADMIN'), downloadStudentTemplate);

// Bulk import uploads
router.post('/staff', authenticateUser, authorizePermissions('ADMIN'), bulkImportStaff);
router.post('/students', authenticateUser, authorizePermissions('ADMIN'), bulkImportStudents);

module.exports = router;
