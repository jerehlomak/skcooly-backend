'use strict';

const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getPayrollStaff,
    getPayrollSettings,
    createPayrollSetting,
    updatePayrollSetting,
    deletePayrollSetting,
    getStaffLoans,
    createStaffLoan,
    updateStaffLoan,
    getStaffPension,
    createPayrollRun,
    getPayrollRuns,
    getPayrollRun,
    confirmPayrollRun,
    exportPayrollRun,
    getPayslip,
} = require('../controllers/payroll.controller');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'BRANCH_ADMIN', 'BRANCH_STAFF'];

// All payroll routes require authentication
router.use(authenticateUser);

// ─── Staff list with payroll summary ─────────────────────────────────────────
router.get('/staff', authorizePermissions(...ADMIN_ROLES), getPayrollStaff);

// ─── Payroll Settings (per-staff earnings & deductions) ──────────────────────
router.get('/settings/:staffId', authorizePermissions(...ADMIN_ROLES), getPayrollSettings);
router.post('/settings', authorizePermissions(...ADMIN_ROLES), createPayrollSetting);
router.put('/settings/:id', authorizePermissions(...ADMIN_ROLES), updatePayrollSetting);
router.delete('/settings/:id', authorizePermissions(...ADMIN_ROLES), deletePayrollSetting);

// ─── Loan Management ─────────────────────────────────────────────────────────
router.get('/loans/:staffId', authorizePermissions(...ADMIN_ROLES), getStaffLoans);
router.post('/loans', authorizePermissions(...ADMIN_ROLES), createStaffLoan);
router.put('/loans/:id', authorizePermissions(...ADMIN_ROLES), updateStaffLoan);

// ─── Pension Tracker ─────────────────────────────────────────────────────────
router.get('/pension/:staffId', authorizePermissions(...ADMIN_ROLES), getStaffPension);

// ─── Payroll Runs ─────────────────────────────────────────────────────────────
router.get('/run', authorizePermissions(...ADMIN_ROLES), getPayrollRuns);
router.post('/run', authorizePermissions(...ADMIN_ROLES), createPayrollRun);
router.get('/run/:id', authorizePermissions(...ADMIN_ROLES), getPayrollRun);
router.post('/run/:id/confirm', authorizePermissions(...ADMIN_ROLES), confirmPayrollRun);
router.get('/run/:id/export', authorizePermissions(...ADMIN_ROLES), exportPayrollRun);

// ─── Payslip ─────────────────────────────────────────────────────────────────
// Accessible to admin (for printing on behalf of non-portal staff)
router.get('/payslip/:staffId/:month/:year', authorizePermissions(...ADMIN_ROLES), getPayslip);

module.exports = router;
