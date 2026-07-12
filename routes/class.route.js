const express = require('express')
const router = express.Router()
const { addClass, getAllClasses, getClass, updateClass, deleteClass, assignFormTeacher, assignSubjectTeacher } = require('../controllers/class.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllClasses)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),addClass)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),getClass)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),updateClass)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),deleteClass)

router.route('/:id/assign-form-teacher').patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),assignFormTeacher)
router.route('/:id/subjects/:subjectId/teacher').patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),assignSubjectTeacher)

module.exports = router
