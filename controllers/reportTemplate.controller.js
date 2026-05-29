const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── DEFAULT TEMPLATE CONFIG ─────────────────────────────────────────────────
const DEFAULT_TEMPLATE_CONFIG = {
    blocks: [
        { id: 'b-header', type: 'SchoolHeaderBlock', isVisible: true },
        { id: 'b-student-info', type: 'StudentInfoBlock', isVisible: true },
        { id: 'b-academic-summary', type: 'AcademicSummaryBlock', isVisible: true },
        { id: 'b-subject-results', type: 'SubjectResultsBlock', isVisible: true },
        { id: 'b-attendance', type: 'AttendanceBlock', isVisible: true },
        { id: 'b-trait-ratings', type: 'TraitRatingsBlock', isVisible: true },
        { id: 'b-comments', type: 'NarrativeCommentsBlock', isVisible: true },
        { id: 'b-signatures', type: 'SignaturesBlock', isVisible: true }
    ],
    design: {
        primaryColor: '#0036a1',
        headerBg: '#0036a1',
        fontFamily: 'serif',
        tableBorderColor: '#d1d5db',
        pageMargin: '10mm',
        logoPosition: 'left',
        headerStyle: 'standard'
    }
};

// ─── GET ALL TEMPLATES ────────────────────────────────────────────────────────
const getTemplates = async (req, res) => {
    const templates = await prisma.reportTemplate.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false },
        include: {
            classAssignments: {
                include: {
                    template: { select: { name: true } }
                }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ templates });
};

// ─── GET SINGLE TEMPLATE ──────────────────────────────────────────────────────
const getTemplateById = async (req, res) => {
    const { id } = req.params;

    const template = await prisma.reportTemplate.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: {
            classAssignments: true
        }
    });

    if (!template) throw new CustomError.NotFoundError(`Template not found`);

    res.status(StatusCodes.OK).json({ template });
};

// ─── GET TEMPLATE FOR A CLASS ─────────────────────────────────────────────────
const getTemplateForClass = async (req, res) => {
    const { classId } = req.params;
    const { type } = req.query;
    const queryType = type || "EXAM";

    const assignment = await prisma.templateClassAssignment.findFirst({
        where: { classId, schoolId: req.user.schoolId, type: queryType },
        include: {
            template: true
        }
    });

    if (!assignment) {
        // Return the default template for the school if none assigned
        const defaultTemplate = await prisma.reportTemplate.findFirst({
            where: { schoolId: req.user.schoolId, isDeleted: false, isDefault: true, type: queryType }
        });

        if (!defaultTemplate) {
            return res.status(StatusCodes.OK).json({ template: null, config: DEFAULT_TEMPLATE_CONFIG });
        }
        return res.status(StatusCodes.OK).json({ template: defaultTemplate, config: defaultTemplate.config });
    }

    res.status(StatusCodes.OK).json({
        template: assignment.template,
        config: assignment.template.config
    });
};

// ─── CREATE TEMPLATE ──────────────────────────────────────────────────────────
const createTemplate = async (req, res) => {
    const { name, type, category, config, isDefault } = req.body;

    if (!name) throw new CustomError.BadRequestError('Template name is required');

    const mergedConfig = { ...DEFAULT_TEMPLATE_CONFIG, ...(config || {}) };
    const templateType = type || "EXAM";

    // If this is set as default, un-default others for the SAME type
    if (isDefault) {
        await prisma.reportTemplate.updateMany({
            where: { schoolId: req.user.schoolId, isDefault: true, type: templateType },
            data: { isDefault: false }
        });
    }

    const template = await prisma.reportTemplate.create({
        data: {
            schoolId: req.user.schoolId,
            name,
            type: templateType,
            category: category || null,
            config: mergedConfig,
            isDefault: isDefault || false
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Template created', template });
};

// ─── UPDATE TEMPLATE ──────────────────────────────────────────────────────────
const updateTemplate = async (req, res) => {
    const { id } = req.params;
    const { name, type, category, config, isDefault } = req.body;

    const existing = await prisma.reportTemplate.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false }
    });

    if (!existing) throw new CustomError.NotFoundError(`Template not found`);

    if (isDefault) {
        await prisma.reportTemplate.updateMany({
            where: { schoolId: req.user.schoolId, isDefault: true, type: existing.type, id: { not: id } },
            data: { isDefault: false }
        });
    }

    const merged = { ...existing.config, ...(config || {}) };

    const updated = await prisma.reportTemplate.update({
        where: { id },
        data: {
            name: name || existing.name,
            type: type || existing.type,
            category: category !== undefined ? category : existing.category,
            config: merged,
            isDefault: isDefault !== undefined ? isDefault : existing.isDefault
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Template updated', template: updated });
};

// ─── DELETE TEMPLATE ──────────────────────────────────────────────────────────
const deleteTemplate = async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.reportTemplate.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false }
    });

    if (!existing) throw new CustomError.NotFoundError(`Template not found`);

    await prisma.reportTemplate.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    res.status(StatusCodes.OK).json({ msg: 'Template deleted' });
};

// ─── ASSIGN TEMPLATE TO CLASSES ───────────────────────────────────────────────
const assignTemplateToClasses = async (req, res) => {
    const { id } = req.params;
    const { classIds } = req.body; // array of class IDs

    if (!classIds || !Array.isArray(classIds)) {
        throw new CustomError.BadRequestError('classIds array is required');
    }

    const template = await prisma.reportTemplate.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false }
    });

    if (!template) throw new CustomError.NotFoundError(`Template not found`);

    // Upsert assignments for each classId
    const ops = classIds.map(classId =>
        prisma.templateClassAssignment.upsert({
            where: { schoolId_classId_type: { schoolId: req.user.schoolId, classId, type: template.type } },
            update: { templateId: id },
            create: { schoolId: req.user.schoolId, templateId: id, classId, type: template.type }
        })
    );

    await prisma.$transaction(ops);

    res.status(StatusCodes.OK).json({ msg: 'Template assigned to classes' });
};

// ─── GET DEFAULT CONFIG ───────────────────────────────────────────────────────
const getDefaultConfig = async (req, res) => {
    res.status(StatusCodes.OK).json({ config: DEFAULT_TEMPLATE_CONFIG });
};

module.exports = {
    getTemplates,
    getTemplateById,
    getTemplateForClass,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    assignTemplateToClasses,
    getDefaultConfig,
    DEFAULT_TEMPLATE_CONFIG
};
