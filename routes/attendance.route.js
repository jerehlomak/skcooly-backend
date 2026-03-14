const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
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
    getMyAttendance
} = require('../controllers/attendance.controller');

const adminTeacher = authorizePermissions('ADMIN', 'TEACHER');
const adminOnly = authorizePermissions('ADMIN');

// Attendance routes (Staff only)
router.get('/attendance/stats', authenticateUser, adminTeacher, getAttendanceStats);
router.get('/attendance/roster', authenticateUser, adminTeacher, getAttendanceRoster);
router.post('/attendance/mark', authenticateUser, adminTeacher, markAttendance);
router.get('/attendance/calendar', authenticateUser, adminTeacher, getAttendanceCalendar);
router.get('/attendance/history', authenticateUser, adminTeacher, getStudentHistory);
router.get('/attendance/class-levels', authenticateUser, adminTeacher, getClassLevels);

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
