const express = require('express');
const router = express.Router();
const {
    getGradingScale,
    saveGradingScale,
    getStudentReportCard,
    getClassReportCards,
    saveComment,
    getAdminClassResults,
    getBroadsheet,
    computeClassResultsEndpoint,
    updateEntryStatus,
    getSubjectEntryStatus,
    updateReleaseStatus,
    getTraitConfigurations,
    saveTraitConfiguration,
    getTraitRatings,
    saveTraitRatings,
    generateReportCardPDF,
    getCumulativeBroadsheet,
    getTemplatePreview,
    saveResultTemplate,
    getResultTemplate,
    getAllTemplates,
    createResultTemplate,
    updateResultTemplate,
    deleteResultTemplate,
    getCommentRules,
    saveCommentRule,
    deleteCommentRule,
    shareResultEndpoint,
    generatePrintToken,
    validateResults,
    batchExportPDF
} = require('../controllers/result.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Grading scale
router.get('/grading-scale', authenticateUser, getGradingScale);
router.post('/grading-scale', authenticateUser, authorizePermissions('ADMIN'), saveGradingScale);

// Report card data
router.get('/report-card', authenticateUser, getStudentReportCard);
router.get('/report-card/pdf', authenticateUser, generateReportCardPDF);
router.get('/templates', authenticateUser, getAllTemplates);
router.get('/template-preview', authenticateUser, getTemplatePreview);
router.get('/template', authenticateUser, getResultTemplate);
router.post('/template', authenticateUser, authorizePermissions('ADMIN'), createResultTemplate);
router.put('/template/:id', authenticateUser, authorizePermissions('ADMIN'), updateResultTemplate);
router.delete('/template/:id', authenticateUser, authorizePermissions('ADMIN'), deleteResultTemplate);
router.get('/class-report', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getClassReportCards);
router.get('/admin-class', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAdminClassResults);
router.get('/broadsheet', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getBroadsheet);
router.get('/cumulative-broadsheet', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getCumulativeBroadsheet);

// Comments (manual per-student)
router.post('/comment', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), saveComment);

// Comment Rules (auto-comment)
router.get('/comment-rules', authenticateUser, authorizePermissions('ADMIN'), getCommentRules);
router.post('/comment-rules', authenticateUser, authorizePermissions('ADMIN'), saveCommentRule);
router.delete('/comment-rules/:id', authenticateUser, authorizePermissions('ADMIN'), deleteCommentRule);

// Sharing
router.post('/share', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), shareResultEndpoint);

// Phase 1 Core Infrastructure
router.post('/compute', authenticateUser, authorizePermissions('ADMIN'), computeClassResultsEndpoint);
router.post('/entry-status', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), updateEntryStatus);
router.get('/entry-status', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getSubjectEntryStatus);
router.post('/release-status', authenticateUser, authorizePermissions('ADMIN'), updateReleaseStatus);

// Trait Ratings
router.get('/traits/config', authenticateUser, getTraitConfigurations);
router.post('/traits/config', authenticateUser, authorizePermissions('ADMIN'), saveTraitConfiguration);
router.get('/traits', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getTraitRatings);
router.post('/traits', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), saveTraitRatings);

// Print & Export
router.get('/print/token', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), generatePrintToken);
router.get('/print/validate', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), validateResults);
router.post('/print/batch', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), batchExportPDF);

module.exports = router;
