const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');
const { uploadLegacyResultPdf, deleteFile } = require('../services/cloudinary-upload.service');

// ─── UPLOAD LEGACY RESULT PDF ──────────────────────────────────────────
const uploadLegacyResult = async (req, res) => {
    const { classId, academicYear, term, sessionName } = req.body;
    const schoolId = req.user.schoolId;

    if (!classId || !academicYear || !term) {
        throw new CustomError.BadRequestError('Please provide classId, academicYear, and term');
    }

    if (!req.files || !req.files.file) {
        throw new CustomError.BadRequestError('Please provide a PDF file');
    }

    // Check if class exists
    const classExists = await prisma.class.findUnique({ where: { id: classId, schoolId } });
    if (!classExists) {
        throw new CustomError.NotFoundError(`Class with id ${classId} not found`);
    }

    // Upload to Cloudinary
    let fileUrl = '';
    try {
        const uploadResult = await uploadLegacyResultPdf(req.files.file, schoolId);
        fileUrl = uploadResult.secure_url;
    } catch (error) {
        throw new CustomError.BadRequestError(`PDF upload failed: ${error.message}`);
    }

    // Save to DB
    const legacyResult = await prisma.legacyResult.create({
        data: {
            schoolId,
            classId,
            academicYear,
            term,
            sessionName: sessionName || null,
            fileUrl,
            uploadedBy: req.user.name || req.user.userId,
        }
    });

    res.status(StatusCodes.CREATED).json({
        msg: 'Legacy result uploaded successfully',
        legacyResult
    });
};

// ─── GET ALL LEGACY RESULTS ─────────────────────────────────────────────
const getAllLegacyResults = async (req, res) => {
    const schoolId = req.user.schoolId;

    const legacyResults = await prisma.legacyResult.findMany({
        where: { schoolId },
        include: {
            class: {
                select: { name: true, level: true }
            }
        },
        orderBy: [
            { academicYear: 'desc' },
            { term: 'desc' }
        ]
    });

    res.status(StatusCodes.OK).json({
        legacyResults,
        count: legacyResults.length
    });
};

// ─── DELETE LEGACY RESULT ───────────────────────────────────────────────
const deleteLegacyResult = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const legacyResult = await prisma.legacyResult.findUnique({
        where: { id }
    });

    if (!legacyResult || legacyResult.schoolId !== schoolId) {
        throw new CustomError.NotFoundError(`Legacy result with id ${id} not found`);
    }

    // We could extract public_id from secure_url to delete from Cloudinary if desired
    // For now, we just delete the database record
    await prisma.legacyResult.delete({
        where: { id }
    });

    res.status(StatusCodes.OK).json({ msg: 'Legacy result deleted successfully' });
};

module.exports = {
    uploadLegacyResult,
    getAllLegacyResults,
    deleteLegacyResult
};
