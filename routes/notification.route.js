const express = require('express');
const router = express.Router();
const { getMyNotifications, markAsRead, markAllAsRead } = require('../controllers/notification.controller');
const { authenticateUser } = require('../middleware/authentication');

router.use(authenticateUser);

router.get('/', getMyNotifications);
router.post('/mark-all-read', markAllAsRead);
router.patch('/:id/read', markAsRead);

module.exports = router;
