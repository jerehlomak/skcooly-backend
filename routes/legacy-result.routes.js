const express = require('express');
const router = express.Router();
const { uploadLegacyResult, getAllLegacyResults, deleteLegacyResult } = require('../controllers/legacy-result.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);
// Only admins can manage legacy results
router.use(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'));

router.post('/', uploadLegacyResult);
router.get('/', getAllLegacyResults);
router.delete('/:id', deleteLegacyResult);

module.exports = router;
