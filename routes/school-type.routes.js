const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const schoolTypeController = require('../controllers/school-type.controller');

// All routes require authentication and school-admin level access
router.use(authenticateUser);
router.use(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'));

router.get('/', schoolTypeController.listSchoolTypes);
router.post('/', schoolTypeController.createSchoolType);
router.patch('/:id', schoolTypeController.updateSchoolType);
router.delete('/:id', schoolTypeController.deleteSchoolType);
router.post('/:id/default', schoolTypeController.setDefaultSchoolType);

module.exports = router;
