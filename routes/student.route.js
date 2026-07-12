const express = require('express')
const router = express.Router()
const { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent, promoteStudents, checkAdmissionNo, transferStudent } = require('../controllers/student.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

// All routes require authentication + role gating
router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), getAllStudents)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), addStudent)
router.route('/promote').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), promoteStudents)
router.route('/check-admission').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), checkAdmissionNo)
router.route('/:id/transfer').post(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), transferStudent)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), getStudent)
    .patch(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), updateStudent)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'TEACHER', 'BRANCH_STAFF'), deleteStudent)

module.exports = router
