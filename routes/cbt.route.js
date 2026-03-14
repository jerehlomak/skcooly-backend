const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    createQuestion,
    getQuestions,
    createExam,
    updateExam,
    deleteExam,
    getExamDetail,
    getExams,
    submitCBT,
    getCBTResults,
    getStudentCBTResults
} = require('../controllers/cbt.controller');

// Question Banks
router.post('/questions', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), createQuestion);
router.get('/questions', authenticateUser, getQuestions);

// Exams
router.post('/exams', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), createExam);
router.get('/exams', authenticateUser, getExams);
router.route('/exams/:id')
    .get(authenticateUser, getExamDetail)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), updateExam)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), deleteExam);

// Student Exam Execution
router.get('/student-results', authenticateUser, getStudentCBTResults);
router.post('/exams/:id/submit', authenticateUser, authorizePermissions('STUDENT'), submitCBT);
router.get('/exams/:id/results', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getCBTResults);

module.exports = router;
