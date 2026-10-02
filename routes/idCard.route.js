const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const { getIdCardHolders, generateIdCards, getMyIdCard } = require('../controllers/idCard.controller');

const adminOnly = authorizePermissions('ADMIN');

router.get('/holders', authenticateUser, adminOnly, getIdCardHolders);
router.post('/generate', authenticateUser, adminOnly, generateIdCards);
router.get('/me', authenticateUser, getMyIdCard);

module.exports = router;
