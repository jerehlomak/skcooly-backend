const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const isAdmin = authorizePermissions('ADMIN'); // admin check middleware
const schoolTypeController = require('../controllers/school-type.controller');

router.use(authenticateUser);

router.get('/', isAdmin, schoolTypeController.listSchoolTypes);
router.post('/', isAdmin, schoolTypeController.createSchoolType);
router.patch('/:id', isAdmin, schoolTypeController.updateSchoolType);
router.delete('/:id', isAdmin, schoolTypeController.deleteSchoolType);

router.post('/:id/default', isAdmin, schoolTypeController.setDefaultSchoolType);
module.exports = router;
