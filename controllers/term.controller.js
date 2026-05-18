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

module.exports = {
    getAllTerms,
    createTerm,
    updateTerm,
    deleteTerm
};
