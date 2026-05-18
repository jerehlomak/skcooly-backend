const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// ─── GET all scholarships for the school ─────────────────────────────────────
const getScholarships = async (req, res) => {
    const { schoolId } = req.user;
    const { studentId, status } = req.query;

    const scholarships = await prisma.scholarship.findMany({
        where: {
            schoolId,
            isDeleted: false,
            ...(studentId && { studentId }),
            ...(status && { status }),
        },
        include: {
            student: {
                select: {
                    id: true, admissionNo: true, classLevel: true,
                    user: { select: { name: true } }
                }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ scholarships, count: scholarships.length });
};

// ─── GET scholarships for a specific student ──────────────────────────────────
const getStudentScholarships = async (req, res) => {
    const { studentId } = req.params;
    const { schoolId } = req.user;

    const scholarships = await prisma.scholarship.findMany({
        where: { schoolId, studentId, isDeleted: false },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ scholarships });
};

// ─── CREATE ───────────────────────────────────────────────────────────────────
const createScholarship = async (req, res) => {
    const { schoolId } = req.user;
    const { studentId, type, value, description, sponsorName, status, startTerm, startYear, endTerm, endYear } = req.body;

    if (!studentId) throw new CustomError.BadRequestError('studentId is required');
    if (!type) throw new CustomError.BadRequestError('type is required');
    if (value === undefined || value === null || Number(value) < 0) {
        throw new CustomError.BadRequestError('Valid value is required');
    }

    // Validate student belongs to school
    const student = await prisma.studentProfile.findUnique({ where: { id: studentId } });
    if (!student || (student.schoolId && student.schoolId !== schoolId)) {
        throw new CustomError.NotFoundError('Student not found');
    }

    const scholarship = await prisma.scholarship.create({
        data: {
            schoolId, studentId,
            type,
            value: Number(value),
            description: description || null,
            sponsorName: sponsorName || null,
            status: status || 'ACTIVE',
            startTerm: startTerm || null,
            startYear: startYear || null,
            endTerm: endTerm || null,
            endYear: endYear || null,
        },
        include: {
            student: { select: { id: true, admissionNo: true, classLevel: true, user: { select: { name: true } } } }
        }
    });

    res.status(StatusCodes.CREATED).json({ scholarship, msg: 'Scholarship/discount created successfully' });
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────
const updateScholarship = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const existing = await prisma.scholarship.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId || existing.isDeleted) {
        throw new CustomError.NotFoundError('Scholarship not found');
    }

    const d = req.body;
    const scholarship = await prisma.scholarship.update({
        where: { id },
        data: {
            ...(d.type        !== undefined && { type: d.type }),
            ...(d.value       !== undefined && { value: Number(d.value) }),
            ...(d.description !== undefined && { description: d.description }),
            ...(d.sponsorName !== undefined && { sponsorName: d.sponsorName }),
            ...(d.status      !== undefined && { status: d.status }),
            ...(d.startTerm   !== undefined && { startTerm: d.startTerm }),
            ...(d.startYear   !== undefined && { startYear: d.startYear }),
            ...(d.endTerm     !== undefined && { endTerm: d.endTerm }),
            ...(d.endYear     !== undefined && { endYear: d.endYear }),
        },
        include: {
            student: { select: { id: true, admissionNo: true, classLevel: true, user: { select: { name: true } } } }
        }
    });

    res.status(StatusCodes.OK).json({ scholarship, msg: 'Scholarship updated successfully' });
};

// ─── DELETE (soft) ────────────────────────────────────────────────────────────
const deleteScholarship = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const existing = await prisma.scholarship.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId || existing.isDeleted) {
        throw new CustomError.NotFoundError('Scholarship not found');
    }

    await prisma.scholarship.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    res.status(StatusCodes.OK).json({ msg: 'Scholarship removed successfully' });
};

module.exports = { getScholarships, getStudentScholarships, createScholarship, updateScholarship, deleteScholarship };
