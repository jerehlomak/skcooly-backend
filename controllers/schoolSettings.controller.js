
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')

// ─── SEED DEFAULTS ─────────────────────────────────────────────────────────────
const DEFAULTS = {
    PRIMARY: [
        { name: 'Nursery 1', category: 'Nursery', order: 1 },
        { name: 'Nursery 2', category: 'Nursery', order: 2 },
        { name: 'KG 1', category: 'Kindergarten', order: 3 },
        { name: 'KG 2', category: 'Kindergarten', order: 4 },
        { name: 'Primary 1', category: 'Primary', order: 5 },
        { name: 'Primary 2', category: 'Primary', order: 6 },
        { name: 'Primary 3', category: 'Primary', order: 7 },
        { name: 'Primary 4', category: 'Primary', order: 8 },
        { name: 'Primary 5', category: 'Primary', order: 9 },
        { name: 'Primary 6', category: 'Primary', order: 10 },
    ],
    SECONDARY: [
        { name: 'JSS1', category: 'Junior', order: 1 },
        { name: 'JSS2', category: 'Junior', order: 2 },
        { name: 'JSS3', category: 'Junior', order: 3 },
        { name: 'SS1 Science', category: 'Senior', order: 4 },
        { name: 'SS1 Arts', category: 'Senior', order: 5 },
        { name: 'SS1 Commerce', category: 'Senior', order: 6 },
        { name: 'SS2 Science', category: 'Senior', order: 7 },
        { name: 'SS2 Arts', category: 'Senior', order: 8 },
        { name: 'SS2 Commerce', category: 'Senior', order: 9 },
        { name: 'SS3 Science', category: 'Senior', order: 10 },
        { name: 'SS3 Arts', category: 'Senior', order: 11 },
        { name: 'SS3 Commerce', category: 'Senior', order: 12 },
    ],
    ARABIC: [
        { name: 'Awwal', category: 'Arabic', order: 1 },
        { name: 'Thani', category: 'Arabic', order: 2 },
        { name: 'Thalith', category: 'Arabic', order: 3 },
        { name: "Rabi'", category: 'Arabic', order: 4 },
        { name: 'Khamis', category: 'Arabic', order: 5 },
        { name: 'Sadis', category: 'Arabic', order: 6 },
        { name: "Sabi'", category: 'Arabic', order: 7 },
        { name: 'Thamin', category: 'Arabic', order: 8 },
    ],
}

// ─── GET SETTINGS (singleton upsert) ─────────────────────────────────────────
const getSettings = async (req, res) => {
    let settings = await prisma.schoolSettings.findFirst()
    if (!settings) {
        settings = await prisma.schoolSettings.create({ data: {} })
    }
    res.status(StatusCodes.OK).json({ settings })
}

// ─── UPDATE SETTINGS ─────────────────────────────────────────────────────────
const updateSettings = async (req, res) => {
    let settings = await prisma.schoolSettings.findFirst()
    const { schoolName, tagline, formTeacherTitle, phone, email, address, country, logoUrl, schoolType, currentTerm, currentYear, currency, rulesContent } = req.body

    if (!settings) {
        settings = await prisma.schoolSettings.create({ data: req.body })
    } else {
        settings = await prisma.schoolSettings.update({
            where: { id: settings.id },
            data: {
                ...(schoolName !== undefined && { schoolName }),
                ...(tagline !== undefined && { tagline }),
                ...(phone !== undefined && { phone }),
                ...(email !== undefined && { email }),
                ...(address !== undefined && { address }),
                ...(country !== undefined && { country }),
                ...(logoUrl !== undefined && { logoUrl }),
                ...(schoolType !== undefined && { schoolType }),
                ...(currentTerm !== undefined && { currentTerm }),
                ...(currentYear !== undefined && { currentYear }),
                ...(currency !== undefined && { currency }),
                ...(rulesContent !== undefined && { rulesContent }),
                ...(formTeacherTitle !== undefined && { formTeacherTitle }),
            }
        })
    }
    res.status(StatusCodes.OK).json({ msg: 'Settings updated', settings })
}

// ─── GET ALL CLASS LEVELS ─────────────────────────────────────────────────────
const getClassLevels = async (req, res) => {
    const levels = await prisma.classLevel.findMany({ orderBy: { order: 'asc' } })
    res.status(StatusCodes.OK).json({ levels, count: levels.length })
}

// ─── ADD CLASS LEVEL ─────────────────────────────────────────────────────────
const addClassLevel = async (req, res) => {
    const { name, category, order } = req.body
    if (!name) throw new CustomError.BadRequestError('Class level name is required')

    // auto-set order to end if not specified
    const maxOrder = await prisma.classLevel.aggregate({ _max: { order: true } })
    const newOrder = order ?? (maxOrder._max.order ?? 0) + 1

    const level = await prisma.classLevel.create({
        data: { name: name.trim(), category: category || null, order: newOrder, isActive: true }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Class level added', level })
}

// ─── UPDATE CLASS LEVEL ───────────────────────────────────────────────────────
const updateClassLevel = async (req, res) => {
    const { id } = req.params
    const { name, category, order, isActive } = req.body
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
    await prisma.classLevel.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Class level deleted' })
}

// ─── SEED CLASS LEVELS by school type ─────────────────────────────────────────
const seedClassLevels = async (req, res) => {
    const { schoolType, replace } = req.body
    if (!DEFAULTS[schoolType]) throw new CustomError.BadRequestError(`Unknown school type: ${schoolType}`)

    if (replace) {
        await prisma.classLevel.deleteMany()
    }
    const levels = DEFAULTS[schoolType]
    // upsert each so multiple calls are idempotent
    const created = await Promise.all(
        levels.map(lvl => prisma.classLevel.upsert({
            where: { name: lvl.name },
            update: { order: lvl.order, category: lvl.category, isActive: true },
            create: lvl
        }))
    )
    res.status(StatusCodes.OK).json({ msg: `Seeded ${created.length} class levels for ${schoolType}`, levels: created })
}

module.exports = { getSettings, updateSettings, getClassLevels, addClassLevel, updateClassLevel, deleteClassLevel, seedClassLevels }
