const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── GRADING SCALE ────────────────────────────────────────────────────────────
const getGradingScale = async (req, res) => {
    const category = req.query.category || 'ALL';
    
    const scale = await prisma.gradingScale.findUnique({
        where: { schoolId_category: { schoolId: req.user.schoolId, category } }
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
        scale: scale || { schoolId: req.user.schoolId, category, passMark: 40, grades: defaultGrades }
    });
};

const saveGradingScale = async (req, res) => {
    const { passMark, grades, category = 'ALL' } = req.body;

    if (!grades || !Array.isArray(grades)) {
        throw new CustomError.BadRequestError('grades array is required');
    }

    const scale = await prisma.gradingScale.upsert({
        where: { schoolId_category: { schoolId: req.user.schoolId, category } },
        update: { passMark: Number(passMark) || 40, grades },
        create: { schoolId: req.user.schoolId, category, passMark: Number(passMark) || 40, grades }
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
        const sp = await prisma.studentProfile.findUnique({ where: { userId: req.user.userId } });
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
            where: { userId: req.user.userId },
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

    // 4. Grading scale — look up by category first, then fall back to 'ALL'
    const studentCategory = results[0]?.category || null;
    let gradingScaleRecord = null;
    if (studentCategory) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: studentCategory }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: 'ALL' }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId }
        });
    }
    const grades = gradingScaleRecord?.grades ?? [];
    const passMark = gradingScaleRecord?.passMark ?? 40;

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

    // Fetch SchoolSettings right away for feature toggles
    const schoolSettingsRecord = await prisma.schoolSettings.findFirst({
        where: { schoolId: req.user.schoolId }
    });

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

        // Subject position logic
        if (schoolSettingsRecord?.resultSubjectPosition) {
             const subjectScores = {}; 
             for (const r of allClassResults) {
                 if (!subjectScores[r.subjectId]) subjectScores[r.subjectId] = [];
                 subjectScores[r.subjectId].push({ sid: r.studentProfileId, score: r.totalScore });
             }
             Object.values(subjectScores).forEach(arr => arr.sort((a,b) => b.score - a.score));
             enrichedResults.forEach(er => {
                 const ranks = subjectScores[er.subjectId];
                 if (ranks) {
                     const r = ranks.findIndex(x => x.sid === studentProfileId);
                     if (r >= 0) er.subjectPosition = r + 1;
                 }
             });
        }
    }

    // 8. Attendance summary
    let attendance = null;
    try {
        if (effectiveClassId) {
            const attnRecords = await prisma.attendanceRecord.findMany({
                where: {
                    studentProfileId,
                    schoolId: req.user.schoolId,
                    classId: effectiveClassId
                }
            });
            const present = attnRecords.filter(a => a.status === 'PRESENT').length;
            const absent = attnRecords.filter(a => a.status === 'ABSENT').length;
            const late = attnRecords.filter(a => a.status === 'LATE').length;
            attendance = { total: attnRecords.length, present, absent, late };
        }
    } catch (_) {
        // Attendance query is non-critical; don't crash the whole report card
        attendance = null;
    }

    // 9. Comments
    let comments = await prisma.studentReportComment.findFirst({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId }
    });

    if (schoolSettingsRecord?.resultAutomaticComments && totalSubjects > 0) {
        const avgScore = totalScore / totalSubjects;
        const autoGrade = computeGrade(avgScore, grades);
        
        let autoTeacherComment = `An ${autoGrade.remark?.toLowerCase() || 'average'} performance. Keep it up!`;
        if (autoGrade.grade === 'F' || autoGrade.grade === 'E') {
            autoTeacherComment = `Needs improvement. More focus is encouraged.`;
        }

        if (!comments) {
            comments = { teacherComment: autoTeacherComment, principalComment: autoGrade.remark, headComment: autoGrade.remark };
        } else {
            if (!comments.teacherComment) comments.teacherComment = autoTeacherComment;
            if (!comments.principalComment) comments.principalComment = autoGrade.remark;
            if (!comments.headComment) comments.headComment = autoGrade.remark;
        }
    }

    // 10. School info
    const schoolInfo = await prisma.school.findUnique({
        where: { id: req.user.schoolId }
    });

    // 11. Cumulative / Annual logic
    let annualResults = [];
    let cumulativeAverage = null;

    if (term === 'Third Term') {
        const allTermsResults = await prisma.studentResult.findMany({
            where: { studentProfileId, academicYear, schoolId: req.user.schoolId },
            include: { subject: { select: { name: true, id: true } } }
        });

        const subjectMap = {};
        allTermsResults.forEach(r => {
             if (!subjectMap[r.subjectId]) {
                 subjectMap[r.subjectId] = { subject: r.subject, first: null, second: null, third: null };
             }
             if (r.term === 'First Term') subjectMap[r.subjectId].first = r.totalScore;
             if (r.term === 'Second Term') subjectMap[r.subjectId].second = r.totalScore;
             if (r.term === 'Third Term') subjectMap[r.subjectId].third = r.totalScore;
        });

        let cumTotal = 0, cumCount = 0;
        Object.values(subjectMap).forEach(sm => {
            let sum = 0, count = 0;
            if (sm.first !== null) { sum += sm.first; count++; }
            if (sm.second !== null) { sum += sm.second; count++; }
            if (sm.third !== null) { sum += sm.third; count++; }
            if (count > 0) {
                 const avg = parseFloat((sum / count).toFixed(1));
                 cumTotal += avg; cumCount++;
                 sm.cumulative = avg;
                 annualResults.push(sm);
            }
        });
        if (cumCount > 0) cumulativeAverage = (cumTotal / cumCount).toFixed(1);
    }

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
            passMark,
            cumulativeAverage
        },
        attendance,
        comments: comments || null,
        annualResults,
        templateConfig,
        schoolSettings: schoolInfo ? {
            schoolName: schoolInfo.name,
            address: schoolInfo.address,
            phone: schoolInfo.phone,
            email: schoolInfo.email,
            logoUrl: schoolInfo.logoUrl,
            resultShowBorder: schoolSettingsRecord?.resultShowBorder ?? true,
            resultShowSignature: schoolSettingsRecord?.resultShowSignature ?? true,
            resultShowNextTermFees: schoolSettingsRecord?.resultShowNextTermFees ?? false,
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

// ─── ADMIN: GET BROADSHEET (MASTER LIST) ──────────────────────────────────
const getBroadsheet = async (req, res) => {
    const { classId, term, academicYear } = req.query;

    if (!classId || !term || !academicYear) {
        throw new CustomError.BadRequestError('classId, term, and academicYear are required');
    }

    const classInfo = await prisma.class.findUnique({
        where: { id: classId, schoolId: req.user.schoolId }
    });
    if (!classInfo) {
        throw new CustomError.NotFoundError('Class not found');
    }

    // Get subjects taught in this class
    const classSubjectsRecords = await prisma.classSubject.findMany({
        where: { classId },
        include: { subject: { select: { id: true, name: true, code: true } } }
    });
    const classSubjects = classSubjectsRecords.map(cs => cs.subject).sort((a,b) => a.name.localeCompare(b.name));

    // Get active students
    const students = await prisma.studentProfile.findMany({
        where: { classId, schoolId: req.user.schoolId, isDeleted: false, status: 'Active' },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    // Get all results
    const results = await prisma.studentResult.findMany({
        where: { classId, term, academicYear, schoolId: req.user.schoolId }
    });

    // Get grading scale
    const gradingScaleRecord = await prisma.gradingScale.findUnique({
        where: { schoolId: req.user.schoolId }
    });
    const grades = gradingScaleRecord ? gradingScaleRecord.grades : [];

    // Group subjects into columns
    const broadsheetMap = {};
    for (const st of students) {
        broadsheetMap[st.id] = {
            studentProfileId: st.id,
            name: st.user.name,
            admissionNo: st.admissionNo,
            gender: st.gender,
            scores: {},
            totalSubjectCount: 0,
            overallTotal: 0,
            average: 0
        };
    }

    for (const r of results) {
        if (broadsheetMap[r.studentProfileId]) {
            const { grade } = computeGrade(r.totalScore, grades);
            broadsheetMap[r.studentProfileId].scores[r.subjectId] = {
                score: r.totalScore,
                grade: grade
            };
            broadsheetMap[r.studentProfileId].totalSubjectCount++;
            broadsheetMap[r.studentProfileId].overallTotal += r.totalScore;
        }
    }

    const broadsheetData = Object.values(broadsheetMap).map(sb => {
        sb.average = sb.totalSubjectCount > 0 ? sb.overallTotal / sb.totalSubjectCount : 0;
        sb.averageStr = sb.average.toFixed(1);
        return sb;
    }).sort((a, b) => b.average - a.average);

    broadsheetData.forEach((st, idx) => st.position = idx + 1);

    res.status(StatusCodes.OK).json({
        classInfo,
        subjects: classSubjects,
        students: broadsheetData,
        term,
        academicYear
    });
};

module.exports = {
    getGradingScale,
    saveGradingScale,
    getStudentReportCard,
    getClassReportCards,
    saveComment,
    getAdminClassResults,
    getBroadsheet
};
