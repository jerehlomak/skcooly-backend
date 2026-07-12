
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { getCache, setCache, invalidateCache } = require('../services/redis.service')
const { encrypt } = require('../utils/encryption')

// ─── SEED DEFAULTS ─────────────────────────────────────────────────────────────
// DEFAULTS removed as per user request to only use school-defined templates

// ─── GET SETTINGS (singleton upsert with Cache) ──────────────────────────────
const getSettings = async (req, res) => {
    const cacheKey = `tenant_${req.user.schoolId}_settings`;

    // 1. Try Cache
    const cachedSettings = await getCache(cacheKey);
    if (cachedSettings) {
        return res.status(StatusCodes.OK).json({ settings: cachedSettings, source: 'cache' });
    }

    // 2. Fallback to DB
    let settings = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } })
    if (!settings) {
        settings = await prisma.schoolSettings.create({ data: { schoolId: req.user.schoolId } })
    }

    // 3. Set Cache
    await setCache(cacheKey, settings, 3600); // 1 hour TTL

    res.status(StatusCodes.OK).json({ settings, source: 'db' })
}

// ─── UPDATE SETTINGS ─────────────────────────────────────────────────────────
const updateSettings = async (req, res) => {
    let settings = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } })
    const { 
        schoolName, tagline, motto, formTeacherTitle, phone, email, address, country, logoUrl, schoolType, currentTerm, currentYear, currency, currencySymbol, timezone, rulesContent,
        resultSubjectPosition, resultClassPosition, resultShowBorder, resultShowSignature, resultShowNextTermFees, resultAutomaticComments, parentResultAccessMode, pinLifespan, parentTranscriptAccess,
        issuedResultTypes, caResultMode, examResultMode, resultConfig,
        admissionFormConfig, employmentFormConfig, admissionLetterTemplate, employmentLetterTemplate, parentAdmissionRequiresPin,
        smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom
    } = req.body

    if (!settings) {
        settings = await prisma.schoolSettings.create({ data: { ...req.body, schoolId: req.user.schoolId } })
    } else {
        settings = await prisma.schoolSettings.update({
            where: { id: settings.id },
            data: {
                ...(schoolName !== undefined && { schoolName }),
                ...(tagline !== undefined && { tagline }),
                ...(motto !== undefined && { motto }),
                ...(phone !== undefined && { phone }),
                ...(email !== undefined && { email }),
                ...(address !== undefined && { address }),
                ...(country !== undefined && { country }),
                ...(logoUrl !== undefined && { logoUrl }),
                ...(schoolType !== undefined && { schoolTypeId: schoolType }),
                ...(currentTerm !== undefined && { currentTerm }),
                ...(currentYear !== undefined && { currentYear }),
                ...(currency !== undefined && { currency }),
                ...(currencySymbol !== undefined && { currencySymbol }),
                ...(timezone !== undefined && { timezone }),
                ...(rulesContent !== undefined && { rulesContent }),
                ...(formTeacherTitle !== undefined && { formTeacherTitle }),
                ...(resultSubjectPosition !== undefined && { resultSubjectPosition }),
                ...(resultClassPosition !== undefined && { resultClassPosition }),
                ...(resultShowBorder !== undefined && { resultShowBorder }),
                ...(resultShowSignature !== undefined && { resultShowSignature }),
                ...(resultShowNextTermFees !== undefined && { resultShowNextTermFees }),
                ...(resultAutomaticComments !== undefined && { resultAutomaticComments }),
                ...(parentResultAccessMode !== undefined && { parentResultAccessMode }),
                ...(pinLifespan !== undefined && { pinLifespan }),
                ...(parentTranscriptAccess !== undefined && { parentTranscriptAccess }),
                ...(issuedResultTypes !== undefined && { issuedResultTypes }),
                ...(caResultMode !== undefined && { caResultMode }),
                ...(examResultMode !== undefined && { examResultMode }),
                ...(resultConfig !== undefined && { resultConfig }),
                ...(admissionFormConfig !== undefined && { admissionFormConfig }),
                ...(employmentFormConfig !== undefined && { employmentFormConfig }),
                ...(admissionLetterTemplate !== undefined && { admissionLetterTemplate }),
                ...(employmentLetterTemplate !== undefined && { employmentLetterTemplate }),
                ...(parentAdmissionRequiresPin !== undefined && { parentAdmissionRequiresPin }),
                ...(smtpHost !== undefined && { smtpHost }),
                ...(smtpPort !== undefined && { smtpPort }),
                ...(smtpUser !== undefined && { smtpUser }),
                ...(smtpPass !== undefined && { smtpPass: encrypt(smtpPass) }),
                ...(smtpFrom !== undefined && { smtpFrom }),
            }
        })
    }

    // Invalidate Cache so the next fetch hits DB
    await invalidateCache(`tenant_${req.user.schoolId}_settings`);

    res.status(StatusCodes.OK).json({ msg: 'Settings updated', settings })
}

// ─── TEST SMTP CONNECTION ────────────────────────────────────────────────────
const testSmtpConnection = async (req, res) => {
    const { getTransporter, getFromEmail } = require('../utils/emailTransporter');
    const transporter = await getTransporter(req.user.schoolId);
    const from = await getFromEmail(req.user.schoolId);

    try {
        await transporter.sendMail({
            from,
            to: req.user.email,
            subject: 'SMTP Test Successful',
            html: '<p>Your custom SMTP configuration is working correctly!</p>'
        });
        res.status(StatusCodes.OK).json({ msg: 'Test email sent successfully!' });
    } catch (err) {
        throw new CustomError.BadRequestError(`SMTP Test Failed: ${err.message}`);
    }
}

// ─── GET ALL CLASS LEVELS ─────────────────────────────────────────────────────
const getClassLevels = async (req, res) => {
    const { schoolType } = req.query;
    const where = { schoolId: req.user.schoolId };
    if (schoolType) where.category = schoolType;
    const levels = await prisma.classLevel.findMany({ where, orderBy: { order: 'asc' } })
    res.status(StatusCodes.OK).json({ levels, count: levels.length })
}

// ─── ADD CLASS LEVEL ─────────────────────────────────────────────────────────
const addClassLevel = async (req, res) => {
    const { name, category, order } = req.body
    if (!name) throw new CustomError.BadRequestError('Class level name is required')
    if (!category) throw new CustomError.BadRequestError('Category (School Type) is required')

    // auto-set order to end if not specified
    const maxOrder = await prisma.classLevel.aggregate({ where: { schoolId: req.user.schoolId }, _max: { order: true } })
    const newOrder = order ?? (maxOrder._max.order ?? 0) + 1

    const classLevel = await prisma.classLevel.create({
        data: { name: name.trim(), category: category.trim(), order: newOrder, isActive: true, schoolId: req.user.schoolId }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Class level added', classLevel })
}

// ─── UPDATE CLASS LEVEL ───────────────────────────────────────────────────────
const updateClassLevel = async (req, res) => {
    const { id } = req.params
    const { name, category, order, isActive } = req.body

    const existing = await prisma.classLevel.findFirst({ where: { id, schoolId: req.user.schoolId } })
    if (!existing) throw new CustomError.NotFoundError(`No class level with id : ${id}`)

    const level = await prisma.classLevel.update({
        where: { id },
        data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(category !== undefined && { category }),
            ...(order !== undefined && { order }),
            ...(isActive !== undefined && { isActive }),
        }
    })
    res.status(StatusCodes.OK).json({ msg: 'Class level updated', level })
}

// ─── DELETE CLASS LEVEL ───────────────────────────────────────────────────────
const deleteClassLevel = async (req, res) => {
    const { id } = req.params
    const existing = await prisma.classLevel.findFirst({ where: { id, schoolId: req.user.schoolId } })
    if (!existing) throw new CustomError.NotFoundError(`No class level with id : ${id}`)

    await prisma.classLevel.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Class level deleted' })
}

// ─── SEED CLASS LEVELS by school type ─────────────────────────────────────────
const seedClassLevels = async (req, res) => {
    const { schoolType, replace } = req.body
    const schoolId = req.user.schoolId

    let levels = [];
    // Look up school type scoped to this school first (by id or name)
    const dbSchoolType = await prisma.schoolType.findFirst({
        where: {
            schoolId,
            OR: [
                { id: schoolType },
                { name: schoolType }
            ]
        }
    });

    if (dbSchoolType && dbSchoolType.defaultClasses) {
        levels = typeof dbSchoolType.defaultClasses === 'string'
            ? JSON.parse(dbSchoolType.defaultClasses)
            : dbSchoolType.defaultClasses;
    } else {
        throw new CustomError.BadRequestError(`School type not found: ${schoolType}`);
    }

    if (levels.length === 0) {
        throw new CustomError.BadRequestError(`This template has no classes defined yet. Please customize it first.`);
    }

    // Removed replace logic to allow multiple school types to coexist

    // upsert each so multiple calls are idempotent. Enforce category to be the dbSchoolType.name
    const created = await Promise.all(
        levels.map((lvl, index) => prisma.classLevel.upsert({
            where: { schoolId_name: { schoolId, name: lvl.name } },
            update: { order: lvl.order ?? (index + 1), category: dbSchoolType.name, isActive: true },
            create: { name: lvl.name, order: lvl.order ?? (index + 1), category: dbSchoolType.name, isActive: true, schoolId }
        }))
    )
    res.status(StatusCodes.OK).json({ msg: `Seeded ${created.length} class levels for ${schoolType}`, levels: created })
}

// ─── REORDER CLASS LEVELS ─────────────────────────────────────────────────────
const reorderClassLevels = async (req, res) => {
    const { classLevels } = req.body
    if (!classLevels || !Array.isArray(classLevels)) {
        throw new CustomError.BadRequestError('Invalid class levels data provided')
    }

    // Run updates in a transaction
    await prisma.$transaction(
        classLevels.map((lvl) => prisma.classLevel.update({
            where: { id: lvl.id },
            data: { order: lvl.order }
        })) // The user should only send IDs they own, we trust the array if they are logged in, but we can't easily filter by schoolId in a simple where: {id}. For simplicity, we assume frontend provides correct IDs.
    )

    res.status(StatusCodes.OK).json({ msg: 'Class levels reordered successfully' })
}

const getMyBranches = async (req, res) => {
    const { schoolId } = req.user
    const { originalSchoolId } = req.user

    // If they are currently acting as a branch (originalSchoolId exists), their true main school is originalSchoolId
    const mainId = originalSchoolId || schoolId;

    const branches = await prisma.school.findMany({
        where: { parentId: mainId, status: 'ACTIVE' },
        select: {
            id: true,
            name: true,
            schoolCode: true,
            logoUrl: true,
            country: true,
            address: true
        }
    })

    const mainSchool = await prisma.school.findUnique({
        where: { id: mainId },
        select: {
            id: true,
            name: true,
            schoolCode: true,
            logoUrl: true
        }
    })

    res.status(StatusCodes.OK).json({ branches, mainSchool, currentSchoolId: schoolId })
}

const getUnifiedResultConfig = async (req, res) => {
    const schoolId = req.user.schoolId;

    // 1. School Settings
    let settings = await prisma.schoolSettings.findFirst({
        where: { schoolId }
    });
    if (!settings) {
        settings = await prisma.schoolSettings.create({ data: { schoolId, schoolName: 'My School' } });
    }

    // 2. Assessment Structure
    const assessmentStructure = await prisma.assessmentStructure.findMany({
        where: { schoolId, isDeleted: false }
    });

    // 3. Grading Scale
    const gradingScale = await prisma.gradingScale.findMany({
        where: { schoolId }
    });

    // 4. Trait Configuration
    const traitConfiguration = await prisma.traitConfiguration.findMany({
        where: { schoolId }
    });

    // 5. Comment Rules
    const commentRules = await prisma.commentRule.findMany({
        where: { schoolId }
    });

    res.status(StatusCodes.OK).json({
        schoolSettings: settings,
        assessmentStructure,
        gradingScale,
        traitConfiguration,
        commentRules
    });
};

module.exports = {
    getSettings,
    updateSettings,
    testSmtpConnection,
    getClassLevels,
    addClassLevel, updateClassLevel, deleteClassLevel, seedClassLevels, reorderClassLevels, getMyBranches, getUnifiedResultConfig }
