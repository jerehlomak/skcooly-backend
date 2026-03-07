const express = require('express')
const router = express.Router()
const {
    getSettings, updateSettings,
    getClassLevels, addClassLevel, updateClassLevel, deleteClassLevel,
    seedClassLevels
} = require('../controllers/schoolSettings.controller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

const admin = [authenticateUser, authorizePermissions('ADMIN')]

// School settings singleton
router.route('/').get(...admin, getSettings).patch(...admin, updateSettings)

// Class levels
router.route('/class-levels').get(authenticateUser, getClassLevels).post(...admin, addClassLevel)
router.route('/class-levels/seed').post(...admin, seedClassLevels)
router.route('/class-levels/:id').patch(...admin, updateClassLevel).delete(...admin, deleteClassLevel)

module.exports = router
