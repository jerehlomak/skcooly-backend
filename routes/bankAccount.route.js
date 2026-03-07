const express = require('express')
const router = express.Router()
const { getBankAccounts, addBankAccount, deleteBankAccount } = require('../controllers/bankAccount.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

const admin = [authenticateUser, authorizePermissions('ADMIN')]

router.route('/').get(authenticateUser, getBankAccounts).post(...admin, addBankAccount)
router.route('/:id').delete(...admin, deleteBankAccount)

module.exports = router
