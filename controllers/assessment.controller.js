const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── GET ASSESSMENT STRUCTURES ──────────────────────────────────────────────
const getAssessmentStructures = async (req, res) => {
    // Return all categories
    const structures = await prisma.assessmentStructure.findMany();

    // Convert array to a keyed object for the frontend: { "Nursery": [...], "Primary": [...] }
    const config = {};
    structures.forEach(s => {
        config[s.category] = s.parts;
    });

    res.status(StatusCodes.OK).json({ config });
};

// ─── UPDATE ASSESSMENT STRUCTURES ───────────────────────────────────────────
const updateAssessmentStructures = async (req, res) => {
    const { category, parts } = req.body;

    if (!category || !parts || !Array.isArray(parts)) {
        throw new CustomError.BadRequestError('Please provide a valid category and parts array');
    }

    // Verify weights total 100
    const totalWeight = parts.reduce((sum, p) => sum + (Number(p.weight) || 0), 0);
    if (totalWeight !== 100) {
        throw new CustomError.BadRequestError('Total weight must equal 100%');
    }

    const structure = await prisma.assessmentStructure.upsert({
        where: { category },
        update: { parts },
        create: { category, parts }
    });

    res.status(StatusCodes.OK).json({ msg: 'Assessment structure updated', structure });
};

// ─── GET SCORES ROSTER (TEACHER) ──────────────────────────────────────────── 
const getScoresRoster = async (req, res) => {
    const { classId, subjectId, term, academicYear } = req.query;

    if (!classId || !subjectId || !term || !academicYear) {
        throw new CustomError.BadRequestError('Please provide classId, subjectId, term, and academicYear');
    }

    // 1. Get Class level -> category mapping to fetch exactly the right columns
    const cls = await prisma.class.findUnique({
        where: { id: classId },
        select: { level: true }
    });

    if (!cls) throw new CustomError.NotFoundError(`No class found with id: ${classId}`);

    // Map Class "level" strings to "category" strings based on the frontend predefined categories
    let category = 'JSS (Junior Secondary)'; // default fallback
    const levelStr = cls.level.toUpperCase();

    if (levelStr.includes('NURSERY') || levelStr.includes('PRE')) {
        category = 'Nursery';
    } else if (levelStr.includes('PRIMARY') || levelStr.includes('PRY')) {
        category = 'Primary';
    } else if (levelStr.includes('JSS') || levelStr.includes('JUNIOR')) {
        category = 'JSS (Junior Secondary)';
    } else if (levelStr.includes('SSS') || levelStr.includes('SS ') || levelStr.includes('SENIOR')) {
        category = 'SSS (Senior Secondary)';
    } else if (levelStr.includes('ARABIC')) {
        category = 'Arabic';
    }

    // Find the current assessment structure
    const structureRecord = await prisma.assessmentStructure.findUnique({
        where: { category }
    });
    const structureDetails = structureRecord ? structureRecord.parts : [];

    // 2. Get students in this class
    const students = await prisma.studentProfile.findMany({
        where: { classLevel: cls.level, status: 'Active' },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    // 3. Get existing results for the filters
    const existingResults = await prisma.studentResult.findMany({
        where: { classId, subjectId, term, academicYear }
    });

    res.status(StatusCodes.OK).json({
        category,
        structure: structureDetails,
        students: students.map(s => ({
            studentProfileId: s.id,
            admissionNo: s.admissionNo,
            name: s.user.name,
            gender: s.gender,
        })),
        results: existingResults
    });
};

// ─── SAVE SCORE (BULK OR SINGLE) ────────────────────────────────────────────
const saveScores = async (req, res) => {
    const { classId, subjectId, term, academicYear, scoresData, category } = req.body;

    // scoresData is an array of items: { studentProfileId, scores (Json object object mapping test to int) }
    if (!classId || !subjectId || !term || !academicYear || !scoresData) {
        throw new CustomError.BadRequestError('Missing required fields for saving scores');
    }

    // Resolve actual teacher ID from the logged in user
    let teacherId = null;
    if (req.user && req.user.role === 'TEACHER') {
        const teacherProfile = await prisma.teacherProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (teacherProfile) teacherId = teacherProfile.id;
    }

    const upsertPromises = scoresData.map(data => {
        // Calculate Total
        let totalScore = 0;
        for (const val of Object.values(data.scores)) {
            totalScore += Number(val) || 0;
        }

        // Very basic grading logic placeholder - you could inject MarksGrading lookup here
        let grade = 'F';
        if (totalScore >= 75) grade = 'A';
        else if (totalScore >= 60) grade = 'B';
        else if (totalScore >= 50) grade = 'C';
        else if (totalScore >= 40) grade = 'D';

        return prisma.studentResult.upsert({
            where: {
                studentProfileId_subjectId_term_academicYear: {
                    studentProfileId: data.studentProfileId,
                    subjectId,
                    term,
                    academicYear
                }
            },
            update: {
                scores: data.scores,
                totalScore,
                grade,
                teacherId
            },
            create: {
                studentProfileId: data.studentProfileId,
                subjectId,
                classId,
                term,
                academicYear,
                category,
                scores: data.scores,
                totalScore,
                grade,
                teacherId
            }
        });
    });

    await prisma.$transaction(upsertPromises);

    res.status(StatusCodes.OK).json({ msg: 'Scores saved successfully' });
};

module.exports = {
    getAssessmentStructures,
    updateAssessmentStructures,
    getScoresRoster,
    saveScores
};
