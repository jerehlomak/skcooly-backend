const express = require('express')
const router = express.Router()
const { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent, promoteStudents, checkAdmissionNo, transferStudent } = require('../controllers/student.controller')
const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication')

// All routes require authentication + permission gating
router.route('/all').get(authenticateUser, requirePermission('std_view'), getAllStudents)
router.route('/add').post(authenticateUser, requirePermission('std_manage'), addStudent)
router.route('/promote').post(authenticateUser, requirePermission('std_manage'), promoteStudents)
router.route('/check-admission').get(authenticateUser, requirePermission('std_view'), checkAdmissionNo)
router.route('/:id/transfer').post(authenticateUser, requirePermission('std_manage'), transferStudent)
router.route('/:id')
    .get(authenticateUser, requirePermission('std_view'), getStudent)
    .patch(authenticateUser, requirePermission('std_manage'), updateStudent)
    .delete(authenticateUser, requirePermission('std_manage'), deleteStudent)

module.exports = router
