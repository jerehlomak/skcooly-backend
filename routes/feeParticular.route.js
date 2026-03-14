const express = require('express')
const router = express.Router()
const { getFeeParticulars, syncFeeParticulars, deleteFeeParticular } = require('../controllers/feeParticular.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

const admin = [authenticateUser, authorizePermissions('ADMIN')]

router.route('/').get(authenticateUser, getFeeParticulars)
router.route('/bulk').post(...admin, syncFeeParticulars)
router.route('/:id').delete(...admin, deleteFeeParticular)

module.exports = router

