const express = require('express');
const router = express.Router();
const { addTeacher, getAllTeachers, getTeacher, updateTeacher, deleteTeacher, getMyClasses, getMySubjects, getMyFormClass } = require('../controllers/teacher.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN'), getAllTeachers)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN'), addTeacher)

router.route('/me/classes').get(authenticateUser, authorizePermissions('TEACHER'), getMyClasses)
router.route('/me/subjects').get(authenticateUser, authorizePermissions('TEACHER'), getMySubjects)
router.route('/me/form-class').get(authenticateUser, authorizePermissions('TEACHER'), getMyFormClass)

router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN'), getTeacher)
    .patch(authenticateUser, authorizePermissions('ADMIN'), updateTeacher)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteTeacher)

module.exports = router;
