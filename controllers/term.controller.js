const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');

// ─── GET ALL TERMS ────────────────────────────────────────────────────────────
const getAllTerms = async (req, res) => {
    const terms = await prisma.academicTerm.findMany({
        where: { schoolId: req.user.schoolId },
        include: { session: true },
        orderBy: { createdAt: 'desc' }
    });
    res.status(StatusCodes.OK).json({ terms, count: terms.length });
};

// ─── CREATE TERM ──────────────────────────────────────────────────────────────
const createTerm = async (req, res) => {
    const { name, startDate, endDate, sessionId, isActive } = req.body;
    if (!name || !sessionId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Term name and Session ID are required' });
    }

    const session = await prisma.academicSession.findFirst({
        where: { id: sessionId, schoolId: req.user.schoolId }
    });

    if (!session) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Invalid Academic Session provided' });
    }

    const existingName = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, sessionId, name: name.trim() }
    });

    if (existingName) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: `Term "${name.trim()}" already exists for this session.` });
    }

    // If this new term is being marked active, deactivate others
    if (isActive) {
        await prisma.academicTerm.updateMany({
            where: { schoolId: req.user.schoolId },
            data: { isActive: false }
        });
    }

    const term = await prisma.academicTerm.create({
        data: {
            schoolId: req.user.schoolId,
            sessionId,
            name: name.trim(),
            startDate: startDate ? new Date(startDate) : null,
            endDate: endDate ? new Date(endDate) : null,
            isActive: isActive || false
        }
    });
    
    res.status(StatusCodes.CREATED).json({ term });
};

// ─── UPDATE TERM ──────────────────────────────────────────────────────────────
const updateTerm = async (req, res) => {
    const { id } = req.params;
    const { name, startDate, endDate, isActive } = req.body;

    const existingTerm = await prisma.academicTerm.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!existingTerm) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No term found with id ${id}` });
    }

    if (name) {
        const existingName = await prisma.academicTerm.findFirst({
            where: { schoolId: req.user.schoolId, sessionId: existingTerm.sessionId, name: name.trim(), id: { not: id } }
        });
        if (existingName) {
            return res.status(StatusCodes.BAD_REQUEST).json({ msg: `Term "${name.trim()}" already exists in this session.` });
        }
    }

    // If making active, deactivate others
    if (isActive && !existingTerm.isActive) {
        await prisma.academicTerm.updateMany({
            where: { schoolId: req.user.schoolId },
            data: { isActive: false }
        });
    }

    const term = await prisma.academicTerm.update({
        where: { id },
        data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
            ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
            ...(isActive !== undefined && { isActive }),
            ...(req.body.daysOpened !== undefined && { daysOpened: parseInt(req.body.daysOpened) || 0 }),
        }
    });
    
    res.status(StatusCodes.OK).json({ term });
};

// ─── DELETE TERM ──────────────────────────────────────────────────────────────
const deleteTerm = async (req, res) => {
    const { id } = req.params;

    const existingTerm = await prisma.academicTerm.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!existingTerm) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No term found with id ${id}` });
    }

    await prisma.academicTerm.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Success! Term deleted.' });
};

// ─── OPEN TERM (ROSTER ROLLOVER & ACTIVATE) ───────────────────────────────────
const openTerm = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const term = await prisma.academicTerm.findFirst({
        where: { id, schoolId },
        include: { session: true }
    });

    if (!term) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No term found with id ${id}` });
    }

    // 1. Deactivate and lock all other terms
    await prisma.academicTerm.updateMany({
        where: { schoolId },
        data: { isActive: false, isLocked: true }
    });

    // 2. Activate and unlock this term
    await prisma.academicTerm.update({
        where: { id },
        data: { isActive: true, isLocked: false }
    });

    // 3. Update Session to be current
    await prisma.academicSession.updateMany({
        where: { schoolId },
        data: { isCurrent: false }
    });
    await prisma.academicSession.update({
        where: { id: term.sessionId },
        data: { isCurrent: true }
    });

    // 4. Update School Settings for backward compatibility
    await prisma.schoolSettings.updateMany({
        where: { schoolId },
        data: {
            currentTerm: term.name,
            currentYear: term.session.name
        }
    });

    // 4. Rollover Active Student Roster
    // Get all active students with a class assigned
    const activeStudents = await prisma.studentProfile.findMany({
        where: { schoolId, isDeleted: false, status: 'Active', classId: { not: null } }
    });

    // Use a transaction or batch insert
    let enrolledCount = 0;
    for (const student of activeStudents) {
        // Upsert to ensure we don't duplicate if they are already enrolled in this term
        await prisma.studentTermEnrollment.upsert({
            where: {
                studentProfileId_academicTermId: {
                    studentProfileId: student.id,
                    academicTermId: id
                }
            },
            update: {
                classId: student.classId,
                sessionId: term.sessionId
            },
            create: {
                schoolId,
                studentProfileId: student.id,
                academicTermId: id,
                classId: student.classId,
                sessionId: term.sessionId
            }
        });
        enrolledCount++;
    }

    res.status(StatusCodes.OK).json({ msg: `Term opened successfully. Roster updated with ${enrolledCount} students.` });
};

// ─── TOGGLE LOCK TERM ─────────────────────────────────────────────────────────
const toggleLock = async (req, res) => {
    const { id } = req.params;
    const { isLocked } = req.body;
    const schoolId = req.user.schoolId;

    const term = await prisma.academicTerm.findFirst({ where: { id, schoolId } });
    if (!term) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No term found with id ${id}` });
    }

    await prisma.academicTerm.update({
        where: { id },
        data: { isLocked }
    });

    res.status(StatusCodes.OK).json({ msg: `Term ${isLocked ? 'locked' : 'unlocked'} successfully.` });
};

// ─── UPDATE ACTIVE TERM DAYS OPENED ─────────────────────────────────────────
const updateActiveTermDaysOpened = async (req, res) => {
    const { daysOpened } = req.body;
    const schoolId = req.user.schoolId;

    const term = await prisma.academicTerm.findFirst({
        where: { schoolId, isActive: true }
    });

    if (!term) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No active term found.` });
    }

    await prisma.academicTerm.update({
        where: { id: term.id },
        data: { daysOpened: parseInt(daysOpened) || 0 }
    });

    res.status(StatusCodes.OK).json({ msg: `Days opened updated successfully.` });
};

module.exports = {
    getAllTerms,
    createTerm,
    updateTerm,
    deleteTerm,
    openTerm,
    toggleLock,
    updateActiveTermDaysOpened
};
