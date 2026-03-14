const express = require('express')
const router = express.Router()
const { getDashboardStats, getMyResults } = require('../controllers/dashboard.controller')
const { authenticateUser } = require('../middleware/authentication')

router.route('/me').get(authenticateUser, getDashboardStats)
router.route('/my-results').get(authenticateUser, getMyResults)

module.exports = router
