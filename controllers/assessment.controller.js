const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { publishEvent, EVENTS } = require('../services/event-bus.service');

// ─── GET ASSESSMENT STRUCTURES ──────────────────────────────────────────────
const getAssessmentStructures = async (req, res) => {
    // Return all categories for this school
    const structures = await prisma.assessmentStructure.findMany({
        where: { schoolId: req.user.schoolId }
    });

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

    const existing = await prisma.assessmentStructure.findFirst({
        where: { category, schoolId: req.user.schoolId }
    });

    let structure;
    if (existing) {
        structure = await prisma.assessmentStructure.update({
            where: { id: existing.id },
            data: { parts }
        });
    } else {
        structure = await prisma.assessmentStructure.create({
            data: { category, parts, schoolId: req.user.schoolId }
        });
    }

    res.status(StatusCodes.OK).json({ msg: 'Assessment structure updated', structure });
};

// ─── GET SCORES ROSTER (TEACHER) ──────────────────────────────────────────── 
const getScoresRoster = async (req, res) => {
    const { classId, subjectId, term, academicYear } = req.query;

    if (!classId || !subjectId || !term || !academicYear) {
        throw new CustomError.BadRequestError('Please provide classId, subjectId, term, and academicYear');
    }

    // 1. Get Class level -> category mapping to fetch exactly the right columns
    const cls = await prisma.class.findFirst({
        where: { id: classId, schoolId: req.user.schoolId },
        select: { level: true }
    });

    if (!cls) throw new CustomError.NotFoundError(`No class found with id: ${classId}`);

    // Find the current assessment structure based directly on the class level name
    const category = cls.level;
    const structureRecord = await prisma.assessmentStructure.findFirst({
        where: { category, schoolId: req.user.schoolId }
    });
    const structureDetails = structureRecord ? structureRecord.parts : [];

    // 2. Get students in this class
    const students = await prisma.studentProfile.findMany({
        where: { classLevel: cls.level, status: 'Active', schoolId: req.user.schoolId },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    // 3. Get existing results for the filters
    const existingResults = await prisma.studentResult.findMany({
        where: { classId, subjectId, term, academicYear, schoolId: req.user.schoolId }
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
        const teacherProfile = await prisma.teacherProfile.findFirst({
            where: { userId: req.user.id, schoolId: req.user.schoolId },
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
                teacherId,
                schoolId: req.user.schoolId
            }
        });
    });

    await prisma.$transaction(upsertPromises);

    // Dispatch the Result Added event
    publishEvent(EVENTS.RESULT_ADDED, {
        schoolId: req.user.schoolId,
        term,
        academicYear,
        subjectId,
        classId,
        studentCount: scoresData.length
    });

    res.status(StatusCodes.OK).json({ msg: 'Scores saved successfully' });
};

// ─── GET MY RESULTS (STUDENT/PARENT) ────────────────────────────────────────
const getMyResults = async (req, res) => {
    const { term, academicYear, studentProfileId } = req.query;

    let targetStudentId = studentProfileId;

    if (req.user.role === 'STUDENT') {
        // Students can only see their own results
        const studentProfile = await prisma.studentProfile.findUnique({
            where: { userId: req.user.id }
        });
        if (!studentProfile) throw new CustomError.NotFoundError('Student profile not found');
        targetStudentId = studentProfile.id;
    } else if (req.user.role === 'PARENT') {
        // Parents can see results for their children
        if (!targetStudentId) throw new CustomError.BadRequestError('studentProfileId query parameter is required for parents');
        
        const parentProfile = await prisma.parentProfile.findUnique({
            where: { userId: req.user.id },
            include: { students: true }
        });
        
        if (!parentProfile) throw new CustomError.NotFoundError('Parent profile not found');
        
        const isMyChild = parentProfile.students.some(child => child.id === targetStudentId);
        if (!isMyChild) {
            throw new CustomError.UnauthorizedError('You are not authorized to view results for this student');
        }
    } else {
        throw new CustomError.UnauthorizedError('Only Students and Parents can access this endpoint directly');
    }

    const whereClause = {
        studentProfileId: targetStudentId,
        schoolId: req.user.schoolId
    };

    if (term) whereClause.term = term;
    if (academicYear) whereClause.academicYear = academicYear;

    const results = await prisma.studentResult.findMany({
        where: whereClause,
        include: {
            subject: { select: { name: true, code: true } },
            teacher: { select: { user: { select: { name: true } } } }
        },
        orderBy: { subject: { name: 'asc' } }
    });

    res.status(StatusCodes.OK).json({ results });
};

module.exports = {
    getAssessmentStructures,
    updateAssessmentStructures,
    getScoresRoster,
    saveScores,
    getMyResults
};
