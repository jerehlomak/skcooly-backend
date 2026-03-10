const prisma = require('../db/prisma');
const argon2 = require('argon2');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { createTokenUser, attachCookiesToResponse } = require('../utils');

const login = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw new CustomError.BadRequestError('Please provide email and password');

    const admin = await prisma.groupAdmin.findUnique({
        where: { email },
        include: { group: true }
    });

    if (!admin) throw new CustomError.UnauthenticatedError('Invalid credentials');

    const isPasswordCorrect = await argon2.verify(admin.password, password);
    if (!isPasswordCorrect) throw new CustomError.UnauthenticatedError('Invalid credentials');

    // Update last login
    await prisma.groupAdmin.update({
        where: { id: admin.id },
        data: { lastLogin: new Date() }
    });

    // Create token payload
    const tokenUser = {
        userId: admin.id,
        name: admin.name,
        role: admin.role,
        groupId: admin.groupId
    };

    attachCookiesToResponse({ res, user: tokenUser });

    // Exclude password from response
    const { password: _, ...adminData } = admin;
    res.status(StatusCodes.OK).json({ user: adminData });
}

const logout = async (req, res) => {
    res.cookie('token', '', {
        httpOnly: true,
        expires: new Date(Date.now())
    });
    res.status(StatusCodes.OK).json({ msg: 'User logged out' });
}

const getOverview = async (req, res) => {
    const { groupId } = req.user;

    const group = await prisma.schoolGroup.findUnique({
        where: { id: groupId },
        include: { schools: true }
    });

    if (!group) throw new CustomError.NotFoundError('Group not found');

    const schoolIds = group.schools.map(s => s.id);

    // Real DB counts across all branches
    const [totalStudents, totalTeachers, totalParents] = await Promise.all([
        prisma.studentProfile.count({ where: { schoolId: { in: schoolIds }, NOT: { schoolId: null } } }),
        prisma.teacherProfile.count({ where: { schoolId: { in: schoolIds }, NOT: { schoolId: null } } }),
        prisma.parentProfile.count({ where: { schoolId: { in: schoolIds }, NOT: { schoolId: null } } }),
    ]);

    // Per-branch breakdown
    const branches = await Promise.all(group.schools.map(async (school) => {
        const [students, teachers, parents] = await Promise.all([
            prisma.studentProfile.count({ where: { schoolId: school.id } }),
            prisma.teacherProfile.count({ where: { schoolId: school.id } }),
            prisma.parentProfile.count({ where: { schoolId: school.id } }),
        ]);
        return {
            id: school.id,
            name: school.name,
            schoolCode: school.schoolCode,
            status: school.status,
            students,
            teachers,
            parents,
        };
    }));

    res.status(StatusCodes.OK).json({
        overview: {
            totalSchools: group.schools.length,
            totalStudents,
            totalTeachers,
            totalParents,
            totalRevenue: 0,
            groupName: group.name,
            branches,
        }
    });
}

const getBranches = async (req, res) => {
    const { groupId } = req.user;
    const schools = await prisma.school.findMany({
        where: { groupId }
    });
    res.status(StatusCodes.OK).json({ schools });
}

const createSchoolAdmin = async (req, res) => {
    const { schoolId } = req.params;
    const { email, name, password } = req.body;
    const { groupId } = req.user;

    // Verify ownership
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school || school.groupId !== groupId) {
        throw new CustomError.UnauthorizedError('Unauthorized to manage this school');
    }

    const emailExists = await prisma.user.findUnique({ where: { email } });
    if (emailExists) throw new CustomError.BadRequestError('Email already exists on platform');

    const hashedPassword = await argon2.hash(password);

    const user = await prisma.user.create({
        data: {
            name,
            email,
            password: hashedPassword,
            role: 'ADMIN',
            schoolId
        }
    });

    // Optionally set as primary adminEmail on school record if not already set
    if (!school.adminEmail) {
        await prisma.school.update({
            where: { id: schoolId },
            data: { adminEmail: email }
        });
    }

    const { password: _, ...userData } = user;
    res.status(StatusCodes.CREATED).json({ user: userData });
}

const resetSchoolAdminPassword = async (req, res) => {
    const { adminId } = req.params;
    const { newPassword } = req.body;
    const { groupId } = req.user;

    const targetUser = await prisma.user.findUnique({
        where: { id: adminId }
    });

    if (!targetUser) throw new CustomError.NotFoundError('User not found');

    // Make sure the target user belongs to a school that this GroupAdmin owns
    if (!targetUser.schoolId) throw new CustomError.BadRequestError('User does not belong to a school');

    const school = await prisma.school.findUnique({ where: { id: targetUser.schoolId } });

    if (!school || school.groupId !== groupId) {
        throw new CustomError.UnauthorizedError('Unauthorized to reset this user\'s password');
    }

    if (targetUser.role !== 'ADMIN') {
        throw new CustomError.BadRequestError('You can only reset School Admin passwords via this endpoint');
    }

    const hashedPassword = await argon2.hash(newPassword);

    await prisma.user.update({
        where: { id: adminId },
        data: { password: hashedPassword }
    });

    res.status(StatusCodes.OK).json({ msg: 'Password reset successful' });
}

module.exports = {
    login,
    logout,
    getOverview,
    getBranches,
    createSchoolAdmin,
    resetSchoolAdminPassword
};
