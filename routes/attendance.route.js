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
} = require('../controllers/attendance.controller');

// Attendance routes
router.get('/attendance/stats', authenticateUser, getAttendanceStats);
router.get('/attendance/roster', authenticateUser, getAttendanceRoster);
router.post('/attendance/mark', authenticateUser, markAttendance);
router.get('/attendance/calendar', authenticateUser, getAttendanceCalendar);
router.get('/attendance/history', authenticateUser, getStudentHistory);
router.get('/attendance/class-levels', authenticateUser, getClassLevels);

// Timetable routes
router.get('/timetable', authenticateUser, getTimetable);
router.get('/timetable/setup', authenticateUser, getTimetableSetup);
router.patch('/timetable/setup', authenticateUser, updateTimetableSetup);
router.get('/timetable/classes', authenticateUser, getTimetableClasses);
router.post('/timetable/slot', authenticateUser, upsertTimetableSlot);
router.post('/timetable/save', authenticateUser, saveTimetable);
router.delete('/timetable/slot', authenticateUser, deleteTimetableSlot);
router.get('/timetable/teachers', authenticateUser, getAvailableTeachers);
router.get('/timetable/subjects', authenticateUser, getAvailableSubjects);

module.exports = router;
