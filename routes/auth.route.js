const express = require('express')

const router = express.Router()

const {
    register,
    login,
    logout,
    registerAdmin,
    resetPasswordWithKey,
    switchSchool
} = require('../controllers/auth.controller')
const { authenticateUser } = require('../middleware/authentication')

router.post('/register', register)
router.post('/login', login)
router.get('/logout', logout)
router.post('/register-admin', registerAdmin)
router.post('/reset-password-with-key', resetPasswordWithKey)
router.post('/switch-school', authenticateUser, switchSchool)

module.exports = router