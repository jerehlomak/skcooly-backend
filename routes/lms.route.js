const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    createAssignment,
    getAssignments,
    submitAssignment,
    gradeSubmission,
    getStudentAssignments,
    createLessonResource,
    getLessonResources
} = require('../controllers/lms.controller');

// Assignments
router.post('/assignments', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), createAssignment);
router.get('/assignments', authenticateUser, getAssignments);

// Student Submissions
router.get('/student-assignments', authenticateUser, getStudentAssignments);
router.post('/assignments/:id/submit', authenticateUser, authorizePermissions('STUDENT'), submitAssignment);
router.post('/submissions/:id/grade', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), gradeSubmission);

// Lesson Resources
router.post('/lessons', authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), createLessonResource);
router.get('/lessons', authenticateUser, getLessonResources);

module.exports = router;
