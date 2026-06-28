const express = require('express')
const router = express.Router()
const { addClass, getAllClasses, getClass, updateClass, deleteClass, assignFormTeacher, assignSubjectTeacher } = require('../controllers/class.controller')
const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllClasses)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), addClass)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), getClass)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), updateClass)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), deleteClass)

router.route('/:id/assign-form-teacher').patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), assignFormTeacher)
router.route('/:id/subjects/:subjectId/teacher').patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), assignSubjectTeacher)

module.exports = router
