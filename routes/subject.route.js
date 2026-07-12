const express = require('express')
const router = express.Router()
const { addSubject, getAllSubjects, getSubject, updateSubject, deleteSubject, getMySubjects, getSubjectAllocations, updateSubjectAllocations } = require('../controllers/subject.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/my-subjects').get(authenticateUser, authorizePermissions('STUDENT'), getMySubjects)
router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllSubjects)
router.route('/allocations').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getSubjectAllocations)
router.route('/allocations/:subjectId').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), updateSubjectAllocations)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),addSubject)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),getSubject)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),updateSubject)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'),deleteSubject)

module.exports = router
