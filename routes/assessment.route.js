const express = require('express');
const router = express.Router();

const {
    getAssessmentStructures,
    updateAssessmentStructures,
    getScoresRoster,
    saveScores,
    getMyResults
} = require('../controllers/assessment.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const adminTeacher = authorizePermissions('ADMIN', 'TEACHER');
const adminOnly = authorizePermissions('ADMIN');

router.get('/structure', authenticateUser, adminTeacher, getAssessmentStructures);
router.patch('/structure', authenticateUser, adminOnly, updateAssessmentStructures);
router.get('/scores', authenticateUser, adminTeacher, getScoresRoster);
router.post('/scores', authenticateUser, adminTeacher, saveScores);

// Student/Parent endpoints
router.get('/my-results', authenticateUser, getMyResults);

module.exports = router;
