const express = require('express');
const router = express.Router();
const { addTeacher, getAllTeachers, getTeacher, updateTeacher, deleteTeacher, getMyClasses, getMySubjects, getMyFormClass, reassignTeacher } = require('../controllers/teacher.controller');
const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), getAllTeachers)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), addTeacher)

router.route('/me/classes').get(authenticateUser, authorizePermissions('TEACHER'), getMyClasses)
router.route('/me/subjects').get(authenticateUser, authorizePermissions('TEACHER'), getMySubjects)
router.route('/me/form-class').get(authenticateUser, authorizePermissions('TEACHER'), getMyFormClass)

router.route('/:id/reassign').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), reassignTeacher)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), getTeacher)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), updateTeacher)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), requirePermission('adm_staff'), deleteTeacher)

module.exports = router;
