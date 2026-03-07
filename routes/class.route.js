const express = require('express')
const router = express.Router()
const { addClass, getAllClasses, getClass, updateClass, deleteClass, assignFormTeacher, assignSubjectTeacher } = require('../controllers/class.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllClasses)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN'), addClass)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN'), getClass)
    .patch(authenticateUser, authorizePermissions('ADMIN'), updateClass)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteClass)

router.route('/:id/assign-form-teacher').patch(authenticateUser, authorizePermissions('ADMIN'), assignFormTeacher)
router.route('/:id/subjects/:subjectId/teacher').patch(authenticateUser, authorizePermissions('ADMIN'), assignSubjectTeacher)

module.exports = router
