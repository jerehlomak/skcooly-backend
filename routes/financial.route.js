const express = require('express');
const router = express.Router();
const {
    getTransactions, addTransaction,
    getFeeInvoices, generateBulkInvoices, collectFee,
    getSalaries, paySalary,
    getMyInvoices
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
    .get(authenticateUser, authorizePermissions('ADMIN', 'TEACHER'), getFeeInvoices) // Allow teachers/admin to view fees
    .post(...adminOnly, collectFee); // Only admin/bursar collects fees

router.post('/fees/generate', ...adminOnly, generateBulkInvoices);

// Salary API
router.route('/salaries')
    .get(...adminOnly, getSalaries)
    .post(...adminOnly, paySalary);

// Student/Parent API
router.get('/my-invoices', authenticateUser, getMyInvoices);

module.exports = router;
