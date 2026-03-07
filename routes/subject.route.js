const express = require('express')
const router = express.Router()
const { addSubject, getAllSubjects, getSubject, updateSubject, deleteSubject } = require('../controllers/subject.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getAllSubjects)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN'), addSubject)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN'), getSubject)
    .patch(authenticateUser, authorizePermissions('ADMIN'), updateSubject)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteSubject)

module.exports = router
