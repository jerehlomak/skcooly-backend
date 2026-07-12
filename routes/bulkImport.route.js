const express = require('express');
const router = express.Router();
const {
    downloadStaffTemplate,
    downloadStudentTemplate,
    downloadParentTemplate,
    bulkImportStaff,
    bulkImportStudents,
    bulkImportParents,
} = require('../controllers/bulkImport.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Template downloads
router.get('/template/staff', authenticateUser, authorizePermissions('ADMIN'), downloadStaffTemplate);
router.get('/template/students', authenticateUser, authorizePermissions('ADMIN'), downloadStudentTemplate);
router.get('/template/parents', authenticateUser, authorizePermissions('ADMIN'), downloadParentTemplate);

// Bulk import uploads
router.post('/staff', authenticateUser, authorizePermissions('ADMIN'), bulkImportStaff);
router.post('/students', authenticateUser, authorizePermissions('ADMIN'), bulkImportStudents);
router.post('/parents', authenticateUser, authorizePermissions('ADMIN'), bulkImportParents);

module.exports = router;
