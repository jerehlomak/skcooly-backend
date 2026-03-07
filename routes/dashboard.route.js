const express = require('express')
const router = express.Router()
const { getDashboardStats } = require('../controllers/dashboard.controller')
const { authenticateUser } = require('../middleware/authentication')

router.route('/me').get(authenticateUser, getDashboardStats)

module.exports = router
