const express = require('express');
const router = express.Router();

const {
    getAssessmentStructures,
    updateAssessmentStructures,
    getScoresRoster,
    saveScores
} = require('../controllers/assessment.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.get('/structure', authenticateUser, getAssessmentStructures);
router.patch('/structure', authenticateUser, authorizePermissions('ADMIN'), updateAssessmentStructures);
router.get('/scores', authenticateUser, getScoresRoster);
router.post('/scores', authenticateUser, saveScores);

module.exports = router;
