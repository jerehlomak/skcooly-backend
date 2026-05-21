const express = require('express');
const router = express.Router();
const { generateTranscript } = require('../controllers/transcript.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);

// generateTranscript controller handles specific role checks (Admin vs Parent)
router.get('/:studentId', generateTranscript);

module.exports = router;
