const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const { generateIDCardPDF } = require('../controllers/idCard.controller');
const {
    getAttendanceStats,
    getAttendanceRoster,
    markAttendance,
    getAttendanceCalendar,
    getStudentHistory,
    getClassLevels,
    getTimetable,
    getTimetableClasses,
    upsertTimetableSlot,
    saveTimetable,
    deleteTimetableSlot,
    getAvailableTeachers,
    getAvailableSubjects,
    getTimetableSetup,
    updateTimetableSetup,
    getMyAttendance,

    // QR Management
    generateQR,
    generateBulkQR,
    getQRCodes,
    deactivateQR,
    regenerateQR,
    registerScanner,
    scanQR,

    // Staff Attendance
    getStaffAttendance,
    markStaffManual,
    getStaffAttendanceStats,

    // Settings & Reports
    getAttendanceSettings,
    updateAttendanceSettings,
    getStudentReport,
    getStaffReport
} = require('../controllers/attendance.controller');

const V2 = require('../controllers/attendanceV2.controller');
const g = V2.guard;
const anyUser = authenticateUser;
const adminTeacher = authorizePermissions('ADMIN', 'TEACHER');
const adminOnly = authorizePermissions('ADMIN');

// Student Attendance routes (Staff only)
router.get('/attendance/stats', authenticateUser, adminTeacher, getAttendanceStats);
router.get('/attendance/roster', authenticateUser, adminTeacher, getAttendanceRoster);
router.post('/attendance/mark', authenticateUser, adminTeacher, V2.markRegister);
router.post('/attendance/mark-out', authenticateUser, adminTeacher, V2.markRegisterOut);
router.get('/attendance/calendar', authenticateUser, adminTeacher, getAttendanceCalendar);
router.get('/attendance/history', authenticateUser, adminTeacher, getStudentHistory);
router.get('/attendance/class-levels', authenticateUser, adminTeacher, getClassLevels);

// QR Management (Admin/Teacher)
router.post('/attendance/qr/generate', authenticateUser, adminTeacher, generateQR);
router.post('/attendance/qr/generate-bulk', authenticateUser, adminOnly, generateBulkQR);
router.get('/attendance/qr/list', authenticateUser, adminOnly, getQRCodes);
router.post('/attendance/qr/deactivate', authenticateUser, adminOnly, deactivateQR);
router.post('/attendance/qr/regenerate', authenticateUser, adminOnly, regenerateQR);
router.post('/attendance/scanner/register', authenticateUser, adminTeacher, registerScanner);
router.post('/attendance/scan', authenticateUser, adminTeacher, scanQR);
router.get('/attendance/id-card/:userId', authenticateUser, adminTeacher, generateIDCardPDF);

// Staff Attendance routes (Admin only)
router.get('/attendance/staff/roster', authenticateUser, adminOnly, V2.staffRoster);
router.post('/attendance/staff/mark-bulk', authenticateUser, adminOnly, V2.staffMarkBulk);
router.get('/attendance/staff', authenticateUser, adminOnly, getStaffAttendance);
router.post('/attendance/staff/manual', authenticateUser, adminOnly, markStaffManual);
router.get('/attendance/staff/stats', authenticateUser, adminOnly, getStaffAttendanceStats);

// Settings
router.get('/attendance/settings', authenticateUser, adminOnly, V2.getSettings);
router.put('/attendance/settings', authenticateUser, adminOnly, V2.updateSettings);
router.get('/attendance/dashboard', authenticateUser, adminOnly, V2.dashboard);
router.get('/attendance/events', authenticateUser, adminOnly, V2.listEvents);
router.get('/attendance/policies', authenticateUser, adminOnly, V2.listPolicies);
router.put('/attendance/policies/:staffId', authenticateUser, adminOnly, V2.putPolicy);
router.get('/attendance/payroll-impact', authenticateUser, adminOnly, V2.payrollImpact);

// Wall QR (admin) and staff self sign-in/out
router.get('/attendance/wall-qr', authenticateUser, adminOnly, V2.getWallQr);
router.post('/attendance/wall-qr/rotate', authenticateUser, adminOnly, V2.rotateWallQr);
router.get('/attendance/wall-qr/poster', authenticateUser, adminOnly, V2.wallPoster);
router.get('/attendance/self/today', anyUser, V2.selfToday);
router.post('/attendance/self/sign', anyUser, g(V2.selfSign));
router.get('/attendance/self/records', anyUser, V2.selfRecords);
router.get('/attendance/preferences', anyUser, V2.getPreferences);
router.put('/attendance/preferences', anyUser, V2.putPreferences);

// Reports
router.get('/attendance/report-options', authenticateUser, adminTeacher, V2.reportOptions);
router.get('/attendance/reports/students', authenticateUser, adminTeacher, V2.reportJson('students'));
router.get('/attendance/reports/students/export', authenticateUser, adminTeacher, V2.exportReport('students'));
router.get('/attendance/reports/staff', authenticateUser, adminOnly, V2.reportJson('staff'));
router.get('/attendance/reports/staff/export', authenticateUser, adminOnly, V2.exportReport('staff'));

// Student/Parent API
router.get('/attendance/my-children', authenticateUser, authorizePermissions('PARENT'), V2.myChildren);
router.get('/my-attendance', authenticateUser, V2.myAttendance);

// Timetable routes
router.get('/timetable', authenticateUser, getTimetable); // Everyone can view
router.get('/timetable/setup', authenticateUser, getTimetableSetup); // Everyone can view
router.patch('/timetable/setup', authenticateUser, adminOnly, updateTimetableSetup);
router.get('/timetable/classes', authenticateUser, getTimetableClasses);
router.post('/timetable/slot', authenticateUser, adminOnly, upsertTimetableSlot);
router.post('/timetable/save', authenticateUser, adminOnly, saveTimetable);
router.delete('/timetable/slot', authenticateUser, adminOnly, deleteTimetableSlot);
router.get('/timetable/teachers', authenticateUser, adminTeacher, getAvailableTeachers);
router.get('/timetable/subjects', authenticateUser, adminTeacher, getAvailableSubjects);

module.exports = router;
