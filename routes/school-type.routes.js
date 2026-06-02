const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const schoolTypeController = require('../controllers/school-type.controller');

// All routes require authentication
router.use(authenticateUser);

const adminAuth = authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN');

router.get('/', schoolTypeController.listSchoolTypes);
router.post('/', adminAuth, schoolTypeController.createSchoolType);
router.patch('/:id', adminAuth, schoolTypeController.updateSchoolType);
router.delete('/:id', adminAuth, schoolTypeController.deleteSchoolType);
router.post('/:id/default', adminAuth, schoolTypeController.setDefaultSchoolType);

module.exports = router;
