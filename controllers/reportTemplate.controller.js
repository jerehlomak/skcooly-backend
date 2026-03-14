const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── DEFAULT TEMPLATE CONFIG ─────────────────────────────────────────────────
const DEFAULT_TEMPLATE_CONFIG = {
    // Layout toggles
    showSchoolLogo: true,
    showSchoolAddress: true,
    showStudentPhoto: true,
    showAdmissionNo: true,
    showClass: true,
    showSession: true,
    showTerm: true,
    showAge: true,
    showGender: true,
    showTeacherName: true,
    showClassAverage: true,
    showSubjectPosition: false,
    showOverallPosition: true,
    showGradingKey: true,
    showAttendance: true,
    showEvaluation: true,
    showTeacherComment: true,
    showHeadComment: true,
    showPrincipalComment: true,
    showNextTerm: true,
    showPromotedTo: false,
    // Document
    reportTitle: 'End of Term Academic Report',
    principalTitle: 'Principal',
    headTeacherTitle: 'Head Teacher',
    formTeacherTitle: 'Form Teacher',
    principalName: '',
    // Design
    primaryColor: '#0036a1',
    headerBg: '#0036a1',
    fontFamily: 'serif',
    tableBorderColor: '#d1d5db',
    pageMargin: '10mm',
    logoPosition: 'left', // left | center | right
    headerStyle: 'standard', // standard | banner | minimal
    // Subject table columns
    subjectColumns: [
        { id: 'ca1', name: '1st CA', key: 'ca1', width: 60, show: true },
        { id: 'ca2', name: '2nd CA', key: 'ca2', width: 60, show: true },
        { id: 'exam', name: 'Exam', key: 'exam', width: 60, show: true },
        { id: 'total', name: 'Total', key: 'total', width: 60, show: true, computed: true },
        { id: 'grade', name: 'Grade', key: 'grade', width: 55, show: true, computed: true },
        { id: 'remark', name: 'Remark', key: 'remark', width: 80, show: true, computed: true },
    ],
    // Evaluation sections
    evaluationSections: [
        {
            id: 'behavior',
            title: 'Behavioural Assessment',
            show: true,
            rows: [
                { id: 'b1', label: 'Attentiveness' },
                { id: 'b2', label: 'Cooperation' },
                { id: 'b3', label: 'Punctuality' },
                { id: 'b4', label: 'Neatness' },
                { id: 'b5', label: 'Leadership' },
            ],
            scale: ['Excellent', 'Very Good', 'Good', 'Fair', 'Poor']
        }
    ],
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

    const assignment = await prisma.templateClassAssignment.findFirst({
        where: { classId, schoolId: req.user.schoolId },
        include: {
            template: true
        }
    });

    if (!assignment) {
        // Return the default template for the school if none assigned
        const defaultTemplate = await prisma.reportTemplate.findFirst({
            where: { schoolId: req.user.schoolId, isDeleted: false, isDefault: true }
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
    const { name, category, config, isDefault } = req.body;

    if (!name) throw new CustomError.BadRequestError('Template name is required');

    const mergedConfig = { ...DEFAULT_TEMPLATE_CONFIG, ...(config || {}) };

    // If this is set as default, un-default others
    if (isDefault) {
        await prisma.reportTemplate.updateMany({
            where: { schoolId: req.user.schoolId, isDefault: true },
            data: { isDefault: false }
        });
    }

    const template = await prisma.reportTemplate.create({
        data: {
            schoolId: req.user.schoolId,
            name,
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
    const { name, category, config, isDefault } = req.body;

    const existing = await prisma.reportTemplate.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false }
    });

    if (!existing) throw new CustomError.NotFoundError(`Template not found`);

    if (isDefault) {
        await prisma.reportTemplate.updateMany({
            where: { schoolId: req.user.schoolId, isDefault: true, id: { not: id } },
            data: { isDefault: false }
        });
    }

    const merged = { ...existing.config, ...(config || {}) };

    const updated = await prisma.reportTemplate.update({
        where: { id },
        data: {
            name: name || existing.name,
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
            where: { schoolId_classId: { schoolId: req.user.schoolId, classId } },
            update: { templateId: id },
            create: { schoolId: req.user.schoolId, templateId: id, classId }
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
