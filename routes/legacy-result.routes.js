const express = require('express');
const router = express.Router();
const { uploadLegacyResult, getAllLegacyResults, deleteLegacyResult, getStudentLegacyResults, getMyLegacyResults } = require('../controllers/legacy-result.controller');
const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

router.use(authenticateUser);

// Allow students, parents, and admins to fetch a student's legacy results
router.get('/my', getMyLegacyResults);
router.get('/student/:studentId', getStudentLegacyResults);

// Only admins can manage legacy results
const adminAuth = authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN');

router.post('/', adminAuth, uploadLegacyResult);
router.get('/', adminAuth, getAllLegacyResults);
router.delete('/:id', adminAuth, deleteLegacyResult);

module.exports = router;
