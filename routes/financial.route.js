const express = require('express');
const router = express.Router();
const {
    getTransactions, addTransaction,
    getFeeInvoices, collectFee,
    getSalaries, paySalary
} = require('../controllers/financial.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Assume admin permissions required for ledger & payroll
const adminOnly = [authenticateUser, authorizePermissions('ADMIN')];

// Ledger API
router.route('/ledger')
    .get(...adminOnly, getTransactions)
    .post(...adminOnly, addTransaction);

// Fees API
router.route('/fees')
    .get(authenticateUser, getFeeInvoices) // Allow teachers/admin to view fees
    .post(...adminOnly, collectFee); // Only admin/bursar collects fees

// Salary API
router.route('/salaries')
    .get(...adminOnly, getSalaries)
    .post(...adminOnly, paySalary);

module.exports = router;
