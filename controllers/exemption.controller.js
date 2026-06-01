const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// ─── GET ALL EXEMPTIONS FOR SCHOOL ───────────────────────────────────────────
const getExemptions = async (req, res) => {
    const schoolId = req.user.schoolId;

    const exemptions = await prisma.activityExemption.findMany({
        where: { schoolId },
        include: {
            user: { select: { name: true, email: true } },
            term: { select: { name: true, session: { select: { name: true } } } },
            class: { select: { name: true, level: true } },
            subject: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ exemptions });
};

// ─── CREATE / GRANT EXEMPTION ────────────────────────────────────────────────
const grantExemption = async (req, res) => {
    const schoolId = req.user.schoolId;
    const adminId = req.user.userId;
    const { termId, userId, activity, classId, subjectId, expiresAt } = req.body;

    if (!termId || !userId || !activity || !expiresAt) {
        throw new CustomError.BadRequestError('termId, userId, activity, and expiresAt are required');
    }

    const expiresDate = new Date(expiresAt);
    if (isNaN(expiresDate.getTime())) {
        throw new CustomError.BadRequestError('Invalid expiration date provided');
    }

    // Verify User exists
    const user = await prisma.user.findFirst({ where: { id: userId, schoolId } });
    if (!user) throw new CustomError.NotFoundError(`No user found with id: ${userId}`);

    // Verify Term exists
    const term = await prisma.academicTerm.findFirst({ where: { id: termId, schoolId } });
    if (!term) throw new CustomError.NotFoundError(`No term found with id: ${termId}`);

    // Create the exemption
    const exemption = await prisma.activityExemption.create({
        data: {
            schoolId,
            termId,
            userId,
            activity,
            classId: classId || null,
            subjectId: subjectId || null,
            expiresAt: expiresDate,
            grantedByAdminId: adminId
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Exemption granted successfully', exemption });
};

// ─── REVOKE EXEMPTION ────────────────────────────────────────────────────────
const revokeExemption = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const existing = await prisma.activityExemption.findFirst({
        where: { id, schoolId }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`No exemption found with id: ${id}`);
    }

    await prisma.activityExemption.delete({ where: { id } });

    res.status(StatusCodes.OK).json({ msg: 'Exemption revoked successfully' });
};

// ─── CHECK EXEMPTION LOGIC (To be called internally by other controllers) ────
// Used by assessment and attendance to see if a user has a valid bypass
const checkExemption = async (schoolId, termId, userId, activity, classId = null, subjectId = null) => {
    const exemptions = await prisma.activityExemption.findMany({
        where: {
            schoolId,
            termId,
            userId,
            activity: { in: ['ALL', activity] },
            expiresAt: { gt: new Date() } // Not expired
        }
    });

    if (exemptions.length === 0) return false;

    // If there is any blanket exemption without class/subject limits, return true
    const blanketExemption = exemptions.find(e => !e.classId && !e.subjectId);
    if (blanketExemption) return true;

    // Otherwise, check if there is an exemption that matches the specific class/subject
    for (let ex of exemptions) {
        const classMatches = !ex.classId || ex.classId === classId;
        const subjectMatches = !ex.subjectId || ex.subjectId === subjectId;
        if (classMatches && subjectMatches) return true;
    }

    return false;
};

module.exports = {
    getExemptions,
    grantExemption,
    revokeExemption,
    checkExemption
};
