const express = require('express');
const router = express.Router();
const {
    getGradingScale,
    saveGradingScale,
    getStudentReportCard,
    getClassReportCards,
    saveComment,
    getAdminClassResults
} = require('../controllers/result.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Grading scale
router.get('/grading-scale', authenticateUser, getGradingScale);
router.post('/grading-scale', authenticateUser, authorizePermissions('ADMIN'), saveGradingScale);

// Report card data
router.get('/report-card', authenticateUser, getStudentReportCard);
router.get('/class-report', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getClassReportCards);
router.get('/admin-class', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAdminClassResults);

// Comments
router.post('/comment', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), saveComment);

module.exports = router;
