const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const author = require('../controllers/cbt.controller');
const run = require('../controllers/cbtExam.controller');
const results = require('../controllers/cbtResults.controller');

// Teachers and admins share the module; ownership / assignment rules are enforced in the controllers.
const staff = [authenticateUser, authorizePermissions('ADMIN', 'TEACHER')];
const admin = [authenticateUser, authorizePermissions('ADMIN')];
const student = [authenticateUser, authorizePermissions('STUDENT')];

// Signed, expiring link for shared results (no login)
router.get('/public/:token', results.publicDownload);

// Meta & settings
router.get('/meta', ...staff, author.getMeta);
router.put('/config', ...admin, author.saveConfig);

// Question bank
router.get('/questions/template', ...staff, author.downloadTemplate);
router.post('/questions/parse', ...staff, author.parseText);
router.post('/questions/import', ...staff, author.importFile);
router.post('/questions/bulk', ...staff, author.bulkCreateQuestions);
router.post('/questions/bulk-delete', ...staff, author.deleteQuestions);
router.route('/questions').get(...staff, author.listQuestions).post(...staff, author.createQuestion);
router.route('/questions/:id').put(...staff, author.updateQuestion).delete(...staff, author.deleteQuestions);

// AI
router.post('/ai/generate', ...staff, author.aiGenerate);

// Class master sheet
router.get('/master-sheet', ...staff, results.getMasterSheet);
router.get('/master-sheet/export', ...staff, results.exportMaster);
router.post('/share/email', ...staff, results.shareEmail);
router.post('/share/link', ...staff, results.createShareLink);

// Student exam execution
router.get('/student/exams', ...student, run.listMyExams);
router.post('/student/exams/:id/start', ...student, run.startExam);
router.put('/student/exams/:id/save', ...student, run.saveProgress);
router.post('/student/exams/:id/submit', ...student, run.submitExam);
router.get('/student/exams/:id/result', ...student, run.getMyResult);
router.get('/student-results', authenticateUser, run.listResultsFor);

// Exams
router.route('/exams').get(...staff, author.listExams).post(...staff, author.createExam);
router.route('/exams/:id').get(...staff, author.getExam).patch(...staff, author.updateExam).delete(...staff, author.deleteExam);
router.post('/exams/:id/duplicate', ...staff, author.duplicateExam);
router.get('/exams/:id/accommodations', ...staff, author.getAccommodations);
router.put('/exams/:id/accommodations/:studentProfileId', ...staff, author.setAccommodation);
router.post('/exams/:id/extend', ...staff, author.extendAll);

// Results, marking, monitoring
router.get('/exams/:id/results', ...staff, results.getExamResults);
router.get('/exams/:id/export', ...staff, results.exportExam);
router.get('/exams/:id/marking', ...staff, results.getMarkingQueue);
router.post('/exams/:id/release', ...staff, results.setRelease);
router.get('/exams/:id/attempts/:studentProfileId', ...staff, results.getAttempt);
router.put('/exams/:id/attempts/:studentProfileId/marks', ...staff, results.saveMarks);
router.post('/exams/:id/attempts/:studentProfileId/suggest', ...staff, results.aiSuggest);
router.post('/exams/:id/attempts/:studentProfileId/release', ...staff, results.releaseAttempt);
router.post('/exams/:id/attempts/:studentProfileId/reset', ...staff, results.resetAttempt);
router.post('/exams/:id/attempts/:studentProfileId/force-submit', ...staff, results.forceSubmit);

module.exports = router;
