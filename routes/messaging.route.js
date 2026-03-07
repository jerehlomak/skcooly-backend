const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const {
    getMessages, getThreads, getThread, sendMessage, deleteMessage,
    getSmsLogs, sendSms, getRecipientGroups,
} = require('../controllers/messaging.controller');

// Internal messaging
router.get('/messages', authenticateUser, getMessages);
router.get('/messages/threads', authenticateUser, getThreads);
router.get('/messages/thread', authenticateUser, getThread);
router.post('/messages', authenticateUser, sendMessage);
router.delete('/messages/:id', authenticateUser, deleteMessage);

// SMS Service
router.get('/sms/logs', authenticateUser, authorizePermissions('ADMIN'), getSmsLogs);
router.get('/sms/groups', authenticateUser, authorizePermissions('ADMIN'), getRecipientGroups);
router.post('/sms/send', authenticateUser, authorizePermissions('ADMIN'), sendSms);

module.exports = router;
