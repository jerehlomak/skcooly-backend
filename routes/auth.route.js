const express = require('express')

const router = express.Router()

const {
    register,
    login,
    logout,
    registerAdmin
} = require('../controllers/auth.controller')

router.post('/register', register)
router.post('/login', login)
router.get('/logout', logout)
router.post('/register-admin', registerAdmin)

module.exports = router