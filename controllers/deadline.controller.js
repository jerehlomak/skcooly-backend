const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// Supported activity types
const VALID_ACTIVITIES = ['SCORE_ENTRY', 'FEE_ENTRY', 'ATTENDANCE', 'CBT'];

// ─── GET ALL DEADLINES FOR SCHOOL ────────────────────────────────────────────
const getAllDeadlines = async (req, res) => {
    const { termId } = req.query;
    const deadlines = await prisma.activityDeadline.findMany({
        where: {
            schoolId: req.user.schoolId,
            ...(termId ? { termId } : {})
        },
        include: { term: { include: { session: true } } },
        orderBy: { deadline: 'asc' }
    });
    res.status(StatusCodes.OK).json({ deadlines });
};

// ─── GET ACTIVE/UPCOMING DEADLINES (for dashboard warnings) ──────────────────
const getActiveDeadlines = async (req, res) => {
    const now = new Date();
    const deadlines = await prisma.activityDeadline.findMany({
        where: {
            schoolId: req.user.schoolId,
            isActive: true,
            deadline: { gte: now } // Only future/current deadlines
        },
        include: { term: { select: { name: true, isActive: true } } },
        orderBy: { deadline: 'asc' }
    });

    // Annotate each deadline with whether warning should be shown
    const annotated = deadlines.map(d => {
        const msUntilDeadline = new Date(d.deadline).getTime() - now.getTime();
        const hoursUntilDeadline = msUntilDeadline / (1000 * 60 * 60);
        return {
            ...d,
            hoursUntilDeadline: Math.max(0, Math.round(hoursUntilDeadline)),
            showWarning: hoursUntilDeadline <= d.warningLeadHours && hoursUntilDeadline > 0
        };
    });

    res.status(StatusCodes.OK).json({ deadlines: annotated });
};

// ─── CREATE / UPSERT DEADLINE ─────────────────────────────────────────────────
const upsertDeadline = async (req, res) => {
    const { termId, activity, deadline, label, warningLeadHours, isActive } = req.body;

    if (!termId || !activity || !deadline) {
        throw new CustomError.BadRequestError('termId, activity, and deadline are required');
    }

    if (!VALID_ACTIVITIES.includes(activity)) {
        throw new CustomError.BadRequestError(
            `Invalid activity. Must be one of: ${VALID_ACTIVITIES.join(', ')}`
        );
    }

    // Verify the term belongs to this school
    const term = await prisma.academicTerm.findFirst({
        where: { id: termId, schoolId: req.user.schoolId }
    });
    if (!term) throw new CustomError.NotFoundError('Term not found');

    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
        throw new CustomError.BadRequestError('Invalid deadline date/time provided');
    }

    const result = await prisma.activityDeadline.upsert({
        where: {
            schoolId_termId_activity: {
                schoolId: req.user.schoolId,
                termId,
                activity
            }
        },
        update: {
            deadline: deadlineDate,
            label: label || null,
            warningLeadHours: warningLeadHours !== undefined ? parseInt(warningLeadHours) : 48,
            isActive: isActive !== undefined ? isActive : true
        },
        create: {
            schoolId: req.user.schoolId,
            termId,
            activity,
            deadline: deadlineDate,
            label: label || null,
            warningLeadHours: warningLeadHours !== undefined ? parseInt(warningLeadHours) : 48,
            isActive: isActive !== undefined ? isActive : true
        },
        include: { term: { select: { name: true } } }
    });

    res.status(StatusCodes.OK).json({ deadline: result, msg: 'Deadline saved successfully' });
};

// ─── DELETE DEADLINE ──────────────────────────────────────────────────────────
const deleteDeadline = async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.activityDeadline.findFirst({
        where: { id, schoolId: req.user.schoolId }
    });
    if (!existing) throw new CustomError.NotFoundError(`No deadline found with id: ${id}`);

    await prisma.activityDeadline.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Deadline removed successfully' });
};

// ─── CHECK IF ACTIVITY IS LOCKED (for internal use & API) ────────────────────
const checkActivityLock = async (req, res) => {
    const { activity, termId } = req.query;
    if (!activity || !termId) {
        throw new CustomError.BadRequestError('activity and termId are required');
    }

    const now = new Date();
    const deadline = await prisma.activityDeadline.findFirst({
        where: {
            schoolId: req.user.schoolId,
            termId,
            activity,
            isActive: true
        }
    });

    if (!deadline) {
        return res.status(StatusCodes.OK).json({ isLocked: false, deadline: null });
    }

    const isLocked = now > new Date(deadline.deadline);
    const hoursUntilDeadline = (new Date(deadline.deadline).getTime() - now.getTime()) / (1000 * 60 * 60);

    res.status(StatusCodes.OK).json({
        isLocked,
        deadline: deadline.deadline,
        warningLeadHours: deadline.warningLeadHours,
        hoursUntilDeadline: Math.max(0, Math.round(hoursUntilDeadline)),
        showWarning: !isLocked && hoursUntilDeadline <= deadline.warningLeadHours
    });
};

module.exports = { getAllDeadlines, getActiveDeadlines, upsertDeadline, deleteDeadline, checkActivityLock };
