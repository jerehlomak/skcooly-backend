const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { publishEvent, EVENTS } = require('../services/event-bus.service');
const { checkExemption } = require('./exemption.controller');

// ─── GET ASSESSMENT STRUCTURES ──────────────────────────────────────────────
const getAssessmentStructures = async (req, res) => {
    const { category, classId, resultType = 'SCORE_BASED' } = req.query;

    const whereClause = { schoolId: req.user.schoolId, resultType };
    if (classId) {
        whereClause.classId = classId;
    } else if (category) {
        whereClause.category = category;
        whereClause.classId = null;
    }

    let structures = await prisma.assessmentStructure.findMany({
        where: whereClause
    });

    // If fetching for a class and no specific structure is found, try fetching its category's structure
    if (classId && structures.length === 0) {
        const cls = await prisma.class.findUnique({ where: { id: classId }, select: { level: true, sectionId: true } });
        if (cls) {
            let catToFind = cls.sectionId || cls.level;
            if (catToFind) {
                structures = await prisma.assessmentStructure.findMany({
                    where: { schoolId: req.user.schoolId, resultType, category: catToFind, classId: null }
                });
            }
        }
    }

    // Fallback to Global Default (ALL) if still no structure is found
    if (structures.length === 0 && (category || classId)) {
        structures = await prisma.assessmentStructure.findMany({
            where: { schoolId: req.user.schoolId, resultType, category: 'ALL', classId: null }
        });
    }

    if (category || classId) {
        return res.status(StatusCodes.OK).json({ parts: structures.length > 0 ? structures[0].parts : null });
    }

    const config = {};
    structures.forEach(s => {
        const key = s.classId ? `CLASS_${s.classId}` : s.category;
        config[key] = s.parts;
    });

    res.status(StatusCodes.OK).json({ config, structures });
};

// ─── UPDATE ASSESSMENT STRUCTURES ───────────────────────────────────────────
const updateAssessmentStructures = async (req, res) => {
    const { category, classId, parts, resultType = 'SCORE_BASED' } = req.body;

    if (!category && !classId) {
        throw new CustomError.BadRequestError('Please provide a valid category or classId');
    }
    if (!parts || !Array.isArray(parts)) {
        throw new CustomError.BadRequestError('Please provide a valid parts array');
    }

    // Verify weights total 100
    const totalWeight = parts.reduce((sum, p) => sum + (Number(p.weight) || 0), 0);
    if (totalWeight !== 100) {
        throw new CustomError.BadRequestError('Total weight must equal 100%');
    }

    const whereClause = { schoolId: req.user.schoolId, resultType };
    if (classId) {
        whereClause.classId = classId;
    } else {
        whereClause.category = category;
        whereClause.classId = null;
    }

    const existing = await prisma.assessmentStructure.findFirst({
        where: whereClause
    });

    let structure;
    if (existing) {
        structure = await prisma.assessmentStructure.update({
            where: { id: existing.id },
            data: { parts }
        });
    } else {
        structure = await prisma.assessmentStructure.create({
            data: { category: category || 'CLASS_OVERRIDE', classId: classId || null, resultType, parts, schoolId: req.user.schoolId }
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

    // 1. Get Class sectionId mapping to fetch exactly the right columns
    const cls = await prisma.class.findFirst({
        where: { id: classId, schoolId: req.user.schoolId },
        select: { level: true, sectionId: true }
    });

    if (!cls) throw new CustomError.NotFoundError(`No class found with id: ${classId}`);

    // Find the current assessment structure based on class override OR class sectionId OR class level name OR class category
    let category = cls.level;
    if (cls.sectionId) {
        category = cls.sectionId;
    } else {
        const classLevelRec = await prisma.classLevel.findFirst({
            where: { schoolId: req.user.schoolId, name: cls.level }
        });
        if (classLevelRec && classLevelRec.category) {
            category = classLevelRec.category;
        }
    }
    
    let structureRecord = await prisma.assessmentStructure.findFirst({
        where: { 
            schoolId: req.user.schoolId,
            classId: classId
        }
    });

    if (!structureRecord) {
        structureRecord = await prisma.assessmentStructure.findFirst({
            where: { 
                schoolId: req.user.schoolId,
                category: { equals: category, mode: 'insensitive' },
                classId: null
            }
        });
    }

    if (!structureRecord) {
        // Fallback to Global Default (ALL)
        structureRecord = await prisma.assessmentStructure.findFirst({
            where: { 
                schoolId: req.user.schoolId,
                category: { equals: 'ALL', mode: 'insensitive' },
                classId: null
            }
        });
    }

    const structureDetails = structureRecord ? structureRecord.parts : [];

    // Fetch the subject to see if it has a category constraint and its type
    const subject = await prisma.subject.findFirst({
        where: { id: subjectId, schoolId: req.user.schoolId },
        select: { categoryId: true, type: true }
    });

    // 2. Get students in this specific class (arm)
    let students = [];
    const termRecord = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });

    // --- HISTORICAL ISOLATION FETCH LOGIC ---
    let combinedIds = new Set();

    // 1. Get IDs from Results (which stores scores)
    const results = await prisma.studentResult.findMany({
        where: { schoolId: req.user.schoolId, classId, term, academicYear },
        select: { studentProfileId: true }
    });
    results.forEach(r => combinedIds.add(r.studentProfileId));

    // 3. Get IDs from Term Enrollments
    if (termRecord) {
        const enrollments = await prisma.studentTermEnrollment.findMany({
            where: { schoolId: req.user.schoolId, academicTermId: termRecord.id, classId },
            select: { studentProfileId: true }
        });
        enrollments.forEach(e => combinedIds.add(e.studentProfileId));
    }

    if (combinedIds.size > 0) {
        students = await prisma.studentProfile.findMany({
            where: { id: { in: Array.from(combinedIds) }, status: 'Active', isDeleted: false },
            include: { user: { select: { name: true } } }
        });
    }

    // 4. Fallback ONLY for the current active term
    const currentSession = await prisma.academicSession.findFirst({
        where: { schoolId: req.user.schoolId, isCurrent: true, isDeleted: false }
    });
    const currentTerm = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, sessionId: currentSession?.id, isActive: true }
    });
    const isCurrentTermRequested = (currentSession?.name === academicYear && currentTerm?.name === term);
    console.log('DEBUG: academicYear=', academicYear, 'term=', term, 'currentSession=', currentSession?.name, 'currentTerm=', currentTerm?.name, 'isCurrentTermRequested=', isCurrentTermRequested);

    if (isCurrentTermRequested) {
        const currentClassStudents = await prisma.studentProfile.findMany({
            where: { classId, status: 'Active', isDeleted: false, schoolId: req.user.schoolId },
            include: { user: { select: { name: true } } }
        });
        console.log('DEBUG: currentClassStudents found=', currentClassStudents.length);
        const existingIds = new Set(students.map(s => s.id));
        currentClassStudents.forEach(cs => {
            if (!existingIds.has(cs.id)) {
                students.push(cs);
                existingIds.add(cs.id);
            }
        });
    }

    console.log('DEBUG: students length before filters=', students.length);

    // Apply subject category filters
    if (subject && subject.categoryId) {
        students = students.filter(s => !s.subjectCategoryId || s.subjectCategoryId === subject.categoryId);
    }
    students.sort((a, b) => a.user.name.localeCompare(b.user.name));

    // NEW: Filter by Elective Allocation if subject is an ELECTIVE
    if (subject && subject.type === 'ELECTIVE') {
        const allocatedStudentIds = (await prisma.studentElective.findMany({
            where: { schoolId: req.user.schoolId, subjectId }
        })).map(a => a.studentProfileId);
        
        students = students.filter(s => allocatedStudentIds.includes(s.id));
    }

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
    try {
        const { classId, subjectId, term, academicYear, scoresData, category } = req.body;

        // scoresData is an array of items: { studentProfileId, scores (Json object object mapping test to int) }
        if (!classId || !subjectId || !term || !academicYear || !scoresData) {
            throw new CustomError.BadRequestError('Missing required fields for saving scores');
        }

        // Verify term lock for Teachers
        if (req.user && req.user.role === 'TEACHER') {
            const termRecord = await prisma.academicTerm.findFirst({
                where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
            });
            if (termRecord) {
                const hasExemption = await checkExemption(req.user.schoolId, termRecord.id, req.user.id, 'SCORE_ENTRY', classId, subjectId);

                if (!hasExemption) {
                    if (termRecord.isLocked) {
                        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'This term is locked. You cannot enter scores.' });
                    }

                    // Check activity deadline
                    const deadlineRecord = await prisma.activityDeadline.findFirst({
                        where: { schoolId: req.user.schoolId, termId: termRecord.id, activity: 'SCORE_ENTRY', isActive: true }
                    });
                    if (deadlineRecord && new Date() > new Date(deadlineRecord.deadline)) {
                        return res.status(StatusCodes.FORBIDDEN).json({
                            msg: `Score entry deadline has passed (${new Date(deadlineRecord.deadline).toLocaleString()}). Please contact the school admin.`
                        });
                    }
                }
            }
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

        // Resolve category if not provided
        let resolvedCategory = category;
        if (!resolvedCategory) {
            const cls = await prisma.class.findFirst({
                where: { id: classId, schoolId: req.user.schoolId },
                select: { level: true, sectionId: true }
            });
            if (!cls) throw new CustomError.NotFoundError(`No class found with id: ${classId}`);
            
            if (cls.sectionId) {
                resolvedCategory = cls.sectionId;
            } else {
                const classLevelRec = await prisma.classLevel.findFirst({
                    where: { schoolId: req.user.schoolId, name: cls.level }
                });
                resolvedCategory = classLevelRec && classLevelRec.category ? classLevelRec.category : cls.level;
            }
        }

        // Fetch Grading Scale for this category (case-insensitive)
        const gradingRecord = await prisma.gradingScale.findFirst({
            where: { 
                schoolId: req.user.schoolId, 
                category: { equals: resolvedCategory, mode: 'insensitive' } 
            }
        });

        let scales = [];
        if (gradingRecord && gradingRecord.grades) {
            scales = gradingRecord.grades;
        } else {
            const fallback = await prisma.gradingScale.findFirst({
                where: { schoolId: req.user.schoolId, category: "ALL" }
            });
            if (fallback && fallback.grades) scales = fallback.grades;
        }

        if (!scales.length) {
            scales = [
                { minScore: 70, maxScore: 100, grade: 'A', status: 'PASS' },
                { minScore: 60, maxScore: 69, grade: 'B', status: 'PASS' },
                { minScore: 50, maxScore: 59, grade: 'C', status: 'PASS' },
                { minScore: 40, maxScore: 49, grade: 'D', status: 'PASS' },
                { minScore: 0, maxScore: 39, grade: 'F', status: 'FAIL' },
            ];
        }

        const upsertPromises = scoresData.map(data => {
            // Calculate Total
            let totalScore = 0;
            for (const val of Object.values(data.scores)) {
                totalScore += Number(val) || 0;
            }

            let grade = '-';
            for (const g of scales) {
                if (totalScore >= Number(g.minScore) && totalScore <= Number(g.maxScore)) {
                    grade = g.grade;
                    break;
                }
            }

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
                    category: resolvedCategory,
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
    } catch (error) {
        console.error('Error in saveScores:', error);
        res.status(error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({
            msg: error.message || 'Internal Server Error',
            error: error.message
        });
    }
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
