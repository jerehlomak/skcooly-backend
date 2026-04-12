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

const adminTeacher = authorizePermissions('ADMIN', 'TEACHER');
const adminOnly = authorizePermissions('ADMIN');

// Student Attendance routes (Staff only)
router.get('/attendance/stats', authenticateUser, adminTeacher, getAttendanceStats);
router.get('/attendance/roster', authenticateUser, adminTeacher, getAttendanceRoster);
router.post('/attendance/mark', authenticateUser, adminTeacher, markAttendance);
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
router.get('/attendance/staff', authenticateUser, adminOnly, getStaffAttendance);
router.post('/attendance/staff/manual', authenticateUser, adminOnly, markStaffManual);
router.get('/attendance/staff/stats', authenticateUser, adminOnly, getStaffAttendanceStats);

// Settings
router.get('/attendance/settings', authenticateUser, adminOnly, getAttendanceSettings);
router.put('/attendance/settings', authenticateUser, adminOnly, updateAttendanceSettings);

// Reports
router.get('/attendance/reports/students', authenticateUser, adminOnly, getStudentReport);
router.get('/attendance/reports/staff', authenticateUser, adminOnly, getStaffReport);

// Student/Parent API
router.get('/my-attendance', authenticateUser, getMyAttendance);

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
