const express = require('express')
const router = express.Router()
const { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent } = require('../controllers/student.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

// All routes require authentication + ADMIN role
router.route('/all').get(authenticateUser, authorizePermissions('ADMIN'), getAllStudents)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN'), addStudent)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN'), getStudent)
    .patch(authenticateUser, authorizePermissions('ADMIN'), updateStudent)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteStudent)

module.exports = router
