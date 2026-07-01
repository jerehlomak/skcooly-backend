const express = require('express')
const router = express.Router()
const { addSubject, getAllSubjects, getSubject, updateSubject, deleteSubject, getMySubjects, getSubjectAllocations, updateSubjectAllocations } = require('../controllers/subject.controller')
const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

router.route('/my-subjects').get(authenticateUser, authorizePermissions('STUDENT'), getMySubjects)
router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllSubjects)
router.route('/allocations').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getSubjectAllocations)
router.route('/allocations/:subjectId').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), updateSubjectAllocations)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), addSubject)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), getSubject)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), updateSubject)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), requirePermission('acd_view'), deleteSubject)

module.exports = router
