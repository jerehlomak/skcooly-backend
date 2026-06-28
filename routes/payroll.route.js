'use strict';

const express = require('express');
const router = express.Router();

const { authenticateUser, authorizePermissions, requirePermission } = require('../middleware/authentication');

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
router.get('/staff', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getPayrollStaff);

// ─── Payroll Settings (per-staff earnings & deductions) ──────────────────────
router.get('/settings/:staffId', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getPayrollSettings);
router.post('/settings', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), createPayrollSetting);
router.put('/settings/:id', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), updatePayrollSetting);
router.delete('/settings/:id', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), deletePayrollSetting);

// ─── Loan Management ─────────────────────────────────────────────────────────
router.get('/loans/:staffId', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getStaffLoans);
router.post('/loans', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), createStaffLoan);
router.put('/loans/:id', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), updateStaffLoan);

// ─── Pension Tracker ─────────────────────────────────────────────────────────
router.get('/pension/:staffId', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getStaffPension);

// ─── Payroll Runs ─────────────────────────────────────────────────────────────
router.get('/run', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getPayrollRuns);
router.post('/run', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), createPayrollRun);
router.get('/run/:id', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getPayrollRun);
router.post('/run/:id/confirm', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), confirmPayrollRun);
router.get('/run/:id/export', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), exportPayrollRun);

// ─── Payslip ─────────────────────────────────────────────────────────────────
// Accessible to admin (for printing on behalf of non-portal staff)
router.get('/payslip/:staffId/:month/:year', authorizePermissions(...ADMIN_ROLES, 'TEACHER', 'BRANCH_STAFF'), requirePermission('fin_salary'), getPayslip);

module.exports = router;
