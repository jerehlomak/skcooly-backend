const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const crypto = require('crypto');

// Utility to generate a random 6-digit numeric key
const generateRecoveryKey = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const generateKeyForUser = async (req, res) => {
    const { userId } = req.params;
    
    // Ensure the user generating the key has permissions to do so for this user
    // Generally, an Admin can generate a key for anyone in their school
    const adminSchoolId = req.user.schoolId;

    const targetUser = await prisma.user.findUnique({
        where: { id: userId }
    });

    if (!targetUser) {
        throw new CustomError.NotFoundError('User not found');
    }

    if (targetUser.schoolId !== adminSchoolId && req.user.role !== 'SCHOOL_SUPER_ADMIN') {
        throw new CustomError.UnauthorizedError('You do not have permission to generate a key for this user');
    }

    const newKey = generateRecoveryKey();
    // Expiration set to 24 hours from now
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
        where: { id: userId },
        data: {
            recoveryKey: newKey,
            recoveryKeyExpires: expiresAt
        }
    });

    res.status(StatusCodes.OK).json({ 
        msg: 'Recovery key generated successfully',
        recoveryKey: newKey,
        expiresAt
    });
};

const verifyKeyAndResetPassword = async (req, res) => {
    // This will be handled in auth.controller.js since it's a public route
    res.status(StatusCodes.OK).json({ msg: 'Not implemented here' });
};

module.exports = {
    generateKeyForUser
};
