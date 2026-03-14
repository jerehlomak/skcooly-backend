const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── GRADING SCALE ────────────────────────────────────────────────────────────
const getGradingScale = async (req, res) => {
    const scale = await prisma.gradingScale.findUnique({
        where: { schoolId: req.user.schoolId }
    });

    const defaultGrades = [
        { id: 'g1', grade: 'A', minScore: 75, maxScore: 100, remark: 'Excellent', status: 'PASS' },
        { id: 'g2', grade: 'B', minScore: 65, maxScore: 74, remark: 'Very Good', status: 'PASS' },
        { id: 'g3', grade: 'C', minScore: 55, maxScore: 64, remark: 'Good', status: 'PASS' },
        { id: 'g4', grade: 'D', minScore: 45, maxScore: 54, remark: 'Pass', status: 'PASS' },
        { id: 'g5', grade: 'E', minScore: 40, maxScore: 44, remark: 'Poor', status: 'PASS' },
        { id: 'g6', grade: 'F', minScore: 0, maxScore: 39, remark: 'Fail', status: 'FAIL' },
    ];

    res.status(StatusCodes.OK).json({
        scale: scale || { schoolId: req.user.schoolId, passMark: 40, grades: defaultGrades }
    });
};

const saveGradingScale = async (req, res) => {
    const { passMark, grades } = req.body;

    if (!grades || !Array.isArray(grades)) {
        throw new CustomError.BadRequestError('grades array is required');
    }

    const scale = await prisma.gradingScale.upsert({
        where: { schoolId: req.user.schoolId },
        update: { passMark: Number(passMark) || 40, grades },
        create: { schoolId: req.user.schoolId, passMark: Number(passMark) || 40, grades }
    });

    res.status(StatusCodes.OK).json({ msg: 'Grading scale saved', scale });
};

// ─── HELPER: Compute grade from total score ───────────────────────────────────
const computeGrade = (totalScore, grades) => {
    if (!grades || !Array.isArray(grades)) return { grade: '-', remark: '-' };
    const sorted = [...grades].sort((a, b) => Number(b.minScore) - Number(a.minScore));
    for (const g of sorted) {
        if (totalScore >= Number(g.minScore) && totalScore <= Number(g.maxScore)) {
            return { grade: g.grade, remark: g.remark || '-' };
        }
    }
    return { grade: 'F', remark: 'Fail' };
};

// ─── GET FULL REPORT CARD FOR A STUDENT ──────────────────────────────────────
const getStudentReportCard = async (req, res) => {
    let { studentProfileId, term, academicYear, classId } = req.query;

    if (!term || !academicYear) {
        throw new CustomError.BadRequestError('term and academicYear are required');
    }

    // Authorization: students can only see their own, parents can see their children
    if (req.user.role === 'STUDENT') {
        const sp = await prisma.studentProfile.findUnique({ where: { userId: req.user.id } });
        if (!sp) throw new CustomError.NotFoundError('Student profile not found');
        if (studentProfileId && sp.id !== studentProfileId) {
            throw new CustomError.UnauthorizedError('Not authorized');
        }
        studentProfileId = sp.id;
    } else {
        if (!studentProfileId) {
            throw new CustomError.BadRequestError('studentProfileId is required');
        }
        if (req.user.role === 'PARENT') {
        const pp = await prisma.parentProfile.findUnique({
            where: { userId: req.user.id },
            include: { students: true }
        });
            if (!pp || !pp.students.some(s => s.id === studentProfileId)) {
                throw new CustomError.UnauthorizedError('Not authorized');
            }
        }
    }

    // 1. Student profile
    const student = await prisma.studentProfile.findFirst({
        where: { id: studentProfileId, schoolId: req.user.schoolId },
        include: {
            user: { select: { name: true } },
            parent: { select: { fatherName: true, motherName: true } },
            classArm: { select: { name: true, level: true, id: true } }
        }
    });

    if (!student) throw new CustomError.NotFoundError('Student not found');

    const effectiveClassId = classId || student.classId;

    // 2. Template for the class
    let templateConfig = null;
    if (effectiveClassId) {
        const assignment = await prisma.templateClassAssignment.findFirst({
            where: { classId: effectiveClassId, schoolId: req.user.schoolId },
            include: { template: true }
        });
        if (assignment) {
            templateConfig = assignment.template.config;
        } else {
            const defaultTmpl = await prisma.reportTemplate.findFirst({
                where: { schoolId: req.user.schoolId, isDefault: true, isDeleted: false }
            });
            if (defaultTmpl) templateConfig = defaultTmpl.config;
        }
    }

    // 3. Results (scores)
    const results = await prisma.studentResult.findMany({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId },
        include: { subject: { select: { name: true, code: true } } },
        orderBy: { subject: { name: 'asc' } }
    });

    // 4. Grading scale
    const gradingScaleRecord = await prisma.gradingScale.findUnique({
        where: { schoolId: req.user.schoolId }
    });
    const grades = gradingScaleRecord ? gradingScaleRecord.grades : [];
    const passMark = gradingScaleRecord ? gradingScaleRecord.passMark : 40;

    // 5. Annotate each result with computed grade/remark
    const enrichedResults = results.map(r => {
        const { grade, remark } = computeGrade(r.totalScore, grades);
        return {
            ...r,
            computedGrade: grade,
            computedRemark: remark,
            isPassing: r.totalScore >= passMark
        };
    });

    // 6. Aggregate stats
    const totalSubjects = enrichedResults.length;
    const totalScore = enrichedResults.reduce((sum, r) => sum + r.totalScore, 0);
    const average = totalSubjects > 0 ? (totalScore / totalSubjects).toFixed(1) : '0';

    // 7. Class context for position/average
    let classAverage = null;
    let overallPosition = null;
    if (effectiveClassId) {
        const allClassResults = await prisma.studentResult.findMany({
            where: { classId: effectiveClassId, term, academicYear, schoolId: req.user.schoolId }
        });

        // Group by student to compute average per student
        const studentTotals = {};
        for (const r of allClassResults) {
            if (!studentTotals[r.studentProfileId]) studentTotals[r.studentProfileId] = { total: 0, count: 0 };
            studentTotals[r.studentProfileId].total += r.totalScore;
            studentTotals[r.studentProfileId].count += 1;
        }

        const averages = Object.entries(studentTotals)
            .map(([sid, d]) => ({ sid, avg: d.count > 0 ? d.total / d.count : 0 }))
            .sort((a, b) => b.avg - a.avg);

        const rank = averages.findIndex(a => a.sid === studentProfileId);
        overallPosition = rank >= 0 ? rank + 1 : null;

        const allAvgs = averages.map(a => a.avg);
        classAverage = allAvgs.length > 0 ? (allAvgs.reduce((s, v) => s + v, 0) / allAvgs.length).toFixed(1) : null;
    }

    // 8. Attendance summary
    let attendance = null;
    if (effectiveClassId) {
        const attnRecords = await prisma.attendanceRecord.findMany({
            where: {
                studentProfileId,
                schoolId: req.user.schoolId,
                class: { id: effectiveClassId }
            }
        });
        const present = attnRecords.filter(a => a.status === 'PRESENT').length;
        const absent = attnRecords.filter(a => a.status === 'ABSENT').length;
        const late = attnRecords.filter(a => a.status === 'LATE').length;
        attendance = { total: attnRecords.length, present, absent, late };
    }

    // 9. Comments
    const comments = await prisma.studentReportComment.findFirst({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId }
    });

    // 10. School info
    const schoolInfo = await prisma.school.findUnique({
        where: { id: req.user.schoolId }
    });

    res.status(StatusCodes.OK).json({
        student: {
            id: student.id,
            name: student.user.name,
            admissionNo: student.admissionNo,
            className: student.classArm?.name || student.classLevel,
            classLevel: student.classArm?.level || student.classLevel,
            gender: student.gender,
            dateOfBirth: student.dateOfBirth,
            term,
            academicYear
        },
        results: enrichedResults,
        summary: {
            totalSubjects,
            totalScore,
            average,
            overallPosition,
            classAverage,
            passMark
        },
        attendance,
        comments: comments || null,
        templateConfig,
        schoolSettings: schoolInfo ? {
            schoolName: schoolInfo.name,
            address: schoolInfo.address,
            phone: schoolInfo.phone,
            email: schoolInfo.email,
            logoUrl: schoolInfo.logoUrl
        } : null,
        gradingScale: { grades, passMark }
    });
};

// ─── GET CLASS REPORT CARDS ───────────────────────────────────────────────────
const getClassReportCards = async (req, res) => {
    const { classId, term, academicYear } = req.query;

    if (!classId || !term || !academicYear) {
        throw new CustomError.BadRequestError('classId, term, and academicYear are required');
    }

    const students = await prisma.studentProfile.findMany({
        where: { classId, schoolId: req.user.schoolId, isDeleted: false, status: 'Active' },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    const gradingScaleRecord = await prisma.gradingScale.findUnique({
        where: { schoolId: req.user.schoolId }
    });
    const grades = gradingScaleRecord ? gradingScaleRecord.grades : [];
    const passMark = gradingScaleRecord ? gradingScaleRecord.passMark : 40;

    const summaries = await Promise.all(students.map(async (student) => {
        const results = await prisma.studentResult.findMany({
            where: { studentProfileId: student.id, term, academicYear, schoolId: req.user.schoolId }
        });

        const totalScore = results.reduce((s, r) => s + r.totalScore, 0);
        const average = results.length > 0 ? (totalScore / results.length).toFixed(1) : '0';
        const subjectCount = results.length;
        const { grade } = computeGrade(parseFloat(average), grades);

        const comments = await prisma.studentReportComment.findFirst({
            where: { studentProfileId: student.id, term, academicYear, schoolId: req.user.schoolId }
        });

        return {
            studentProfileId: student.id,
            admissionNo: student.admissionNo,
            name: student.user.name,
            gender: student.gender,
            subjectCount,
            totalScore,
            average,
            overallGrade: grade,
            comments: comments || null, // RETURN THE FULL COMMENT OBJECT
            isPassing: parseFloat(average) >= passMark
        };
    }));

    // Rank students
    const ranked = [...summaries].sort((a, b) => parseFloat(b.average) - parseFloat(a.average));
    ranked.forEach((s, idx) => { s.position = idx + 1; });

    res.status(StatusCodes.OK).json({ students: ranked, term, academicYear, classId });
};

// ─── SAVE COMMENT ─────────────────────────────────────────────────────────────
const saveComment = async (req, res) => {
    const { studentProfileId, term, academicYear, teacherComment, headComment, principalComment, nextTermBegins, promotedTo } = req.body;

    if (!studentProfileId || !term || !academicYear) {
        throw new CustomError.BadRequestError('studentProfileId, term, and academicYear are required');
    }

    const comment = await prisma.studentReportComment.upsert({
        where: {
            schoolId_studentProfileId_term_academicYear: {
                schoolId: req.user.schoolId,
                studentProfileId,
                term,
                academicYear
            }
        },
        update: { teacherComment, headComment, principalComment, nextTermBegins, promotedTo },
        create: {
            schoolId: req.user.schoolId,
            studentProfileId,
            term,
            academicYear,
            teacherComment,
            headComment,
            principalComment,
            nextTermBegins,
            promotedTo
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Comment saved', comment });
};

// ─── ADMIN: GET RESULTS FOR A CLASS (SCORE ENTRY) ────────────────────────────
const getAdminClassResults = async (req, res) => {
    const { classId, term, academicYear } = req.query;

    if (!classId || !term || !academicYear) {
        throw new CustomError.BadRequestError('classId, term, and academicYear are required');
    }

    const students = await prisma.studentProfile.findMany({
        where: { classId, schoolId: req.user.schoolId, isDeleted: false },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    const results = await prisma.studentResult.findMany({
        where: { classId, term, academicYear, schoolId: req.user.schoolId },
        include: { subject: { select: { name: true, code: true } } }
    });

    const gradingScale = await prisma.gradingScale.findUnique({
        where: { schoolId: req.user.schoolId }
    });

    res.status(StatusCodes.OK).json({ students, results, gradingScale });
};

module.exports = {
    getGradingScale,
    saveGradingScale,
    getStudentReportCard,
    getClassReportCards,
    saveComment,
    getAdminClassResults
};
