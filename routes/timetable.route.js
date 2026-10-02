const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const c = require('../controllers/timetable.controller');

const admin = [authenticateUser, authorizePermissions('ADMIN')];

// Per-user views & reminders (any signed-in school user)
router.get('/my', authenticateUser, c.getMyTimetables);
router.route('/reminders').get(authenticateUser, c.listReminders).post(authenticateUser, c.createReminder);
router.delete('/reminders/:id', authenticateUser, c.deleteReminder);

// Admin setup
router.get('/meta', ...admin, c.getMeta);
router.get('/reminder-targets', ...admin, c.searchReminderTargets);
router.route('/config').get(...admin, c.getConfigs).put(...admin, c.saveConfig);
router.delete('/config/:id', ...admin, c.deleteConfig);
router.route('/alert-settings').get(...admin, c.getAlertSettings).put(...admin, c.saveAlertSettings);
router.get('/section-heads', ...admin, c.getSectionHeads);
router.put('/section-heads/:id', ...admin, c.setSectionHead);

// Timetable documents
router.route('/').get(...admin, c.listTimetables).post(...admin, c.createTimetable);
router.route('/:id').get(...admin, c.getTimetable).patch(...admin, c.updateTimetable).delete(...admin, c.deleteTimetable);
router.post('/:id/duplicate', ...admin, c.duplicateTimetable);
router.post('/:id/generate', ...admin, c.generate);
router.get('/:id/clashes', ...admin, c.getClashes);
router.get('/:id/export', ...admin, c.exportTimetable);
router.post('/:id/slots', ...admin, c.createSlots);
router.route('/:id/slots/:slotId').patch(...admin, c.updateSlot).delete(...admin, c.deleteSlot);
router.delete('/:id/classes/:classId', ...admin, c.clearClass);

module.exports = router;
