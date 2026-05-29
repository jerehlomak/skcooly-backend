const express = require('express');
const router = express.Router();
const { generateTranscript, getTranscriptJSON } = require('../controllers/transcript.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);

// generateTranscript controller handles specific role checks (Admin vs Parent)
router.get('/json/:studentId', getTranscriptJSON);
router.get('/:studentId', generateTranscript);

module.exports = router;