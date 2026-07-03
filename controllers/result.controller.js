const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { generateResultPDF, generateDynamicPDF, generateDynamicPDFs } = require('../services/pdf.service');
const { uploadBufferToCloudinary } = require('../services/cloudinary-upload.service');
const { shareResult } = require('../services/sharing.service');
const jwt = require('jsonwebtoken');

const getGradingScaleType = (resultType) => {
    let rType = 'SCORE_BASED';
    let aType = 'EXAM';
    if (resultType === 'COMMENT_BASED' || resultType === 'COMMENT_EXAM' || resultType === 'COMMENT_CA') {
        rType = 'COMMENT_BASED';
    }
    if (resultType === 'CA_ONLY' || resultType === 'COMMENT_CA' || (!['FULL', 'COMMENT_EXAM'].includes(resultType) && resultType)) {
        aType = 'CA';
    }
    return { resultType: rType, assessmentType: aType };
};

// 🌟🌟🌟 GRADING SCALE 🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟
const getGradingScale = async (req, res) => {
    const category = req.query.category || 'ALL';
    const type = req.query.type || 'SUBJECT';
    const resultType = req.query.resultType || 'SCORE_BASED';
    const assessmentType = req.query.assessmentType || 'EXAM';
    
    const scale = await prisma.gradingScale.findUnique({
        where: { schoolId_category_type_resultType_assessmentType: { schoolId: req.user.schoolId, category, type, resultType, assessmentType } }
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
        scale: scale || { schoolId: req.user.schoolId, category, type, resultType, assessmentType, passMark: 40, grades: defaultGrades }
    });
};

const saveGradingScale = async (req, res) => {
    const { passMark, grades, category = 'ALL', type = 'SUBJECT', resultType = 'SCORE_BASED', assessmentType = 'EXAM' } = req.body;

    if (!grades || !Array.isArray(grades)) {
        throw new CustomError.BadRequestError('grades array is required');
    }

    const scale = await prisma.gradingScale.upsert({
        where: { schoolId_category_type_resultType_assessmentType: { schoolId: req.user.schoolId, category, type, resultType, assessmentType } },
        update: { passMark: Number(passMark) || 40, grades },
        create: { schoolId: req.user.schoolId, category, type, resultType, assessmentType, passMark: Number(passMark) || 40, grades }
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

    // Override with historical class if enrolled for this specific term
    const termRecord = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });
    if (termRecord) {
        const histEnroll = await prisma.studentTermEnrollment.findFirst({
            where: { schoolId: req.user.schoolId, studentProfileId, academicTermId: termRecord.id },
            include: { class: { select: { name: true, level: true, id: true } } }
        });
        if (histEnroll && histEnroll.class) {
            student.classArm = histEnroll.class;
            student.classId = histEnroll.classId;
        }
    }

    const effectiveClassId = classId || student.classId;

    // ── TASK 1.5: Release Gate — parents and students cannot see unreleased results ──
    if (req.user.role === 'STUDENT' || req.user.role === 'PARENT') {
        if (effectiveClassId) {
            
            const releaseRecord = await prisma.resultReleaseStatus.findUnique({
                where: { schoolId_classId_term_academicYear: { schoolId: req.user.schoolId, classId: effectiveClassId, term, academicYear } }
            });
            if (!releaseRecord || !releaseRecord.isReleased) {
                return res.status(200).json({ notReleased: true, message: 'Result not yet released for this term. Please check back later.' });
            }
            req.visibleTypes = releaseRecord.visibleTypes || ['CA', 'EXAM', 'FULL', 'COMMENT'];

        }
    }

    
    let templateConfig = null;
    let sectionName = null;
    if (student.classArm && student.classArm.level) sectionName = student.classArm.level;
    const clsWithSection = await prisma.class.findUnique({ where: { id: effectiveClassId } });
    if (clsWithSection && clsWithSection.level) sectionName = clsWithSection.level;

    const requestedType = req.query.resultType || '';
    let dbTemplateType = 'SCORE_BASED';

    if (requestedType.includes('COMMENT')) {
        dbTemplateType = 'COMMENT_BASED';
    } else if (requestedType === 'TRANSCRIPT') {
        dbTemplateType = 'TRANSCRIPT';
    } else if (!requestedType && req.visibleTypes && req.visibleTypes.length === 1 && req.visibleTypes.includes('COMMENT')) {
        dbTemplateType = 'COMMENT_BASED';
    }

    let template = null;
    if (sectionName) template = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: sectionName, resultType: dbTemplateType }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    if (!template) template = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: null, resultType: dbTemplateType }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    if (template) templateConfig = template.config;


    // 3. Results (scores)
    const results = await prisma.studentResult.findMany({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId },
        include: { subject: { select: { name: true, code: true } } },
        orderBy: { subject: { name: 'asc' } }
    });

    // 4. Grading scale — look up by category first, then fall back to 'ALL'
    const studentCategory = results[0]?.category || null;
    let gradingScaleRecord = null;
    const { resultType: scaleResultType, assessmentType: scaleAssessmentType } = getGradingScaleType(req.query.resultType);
    
    if (studentCategory) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: studentCategory, resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: 'ALL', resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    const grades = gradingScaleRecord?.grades ?? [];
    const passMark = gradingScaleRecord?.passMark ?? 40;

    // 5. Annotate each result with computed grade/remark and extract CAs/Exam
    const enrichedResults = results.map(r => {
        const { grade, remark } = computeGrade(r.totalScore, grades);
        
        const scoresObj = typeof r.scores === 'string' ? JSON.parse(r.scores) : (r.scores || {});
        let ca1 = null, ca2 = null, ca3 = null, exam = null;
        
        for (const [k, v] of Object.entries(scoresObj)) {
            const key = k.toLowerCase();
            if (key.includes('1st ca') || key === 'ca1') ca1 = Number(v);
            else if (key.includes('2nd ca') || key === 'ca2') ca2 = Number(v);
            else if (key.includes('3rd ca') || key === 'ca3') ca3 = Number(v);
            else if (key.includes('exam')) exam = Number(v);
        }

        return {
            ...r,
            scores: scoresObj,
            ca1,
            ca2,
            ca3,
            exam,
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
    
    // Fetch trait configuration
    const traitConfiguration = await prisma.traitConfiguration.findMany({
        where: { schoolId: req.user.schoolId }
    });

    // 7. Class context for position/average
    let classAverage = null;
    let highestAvg = null;
    let lowestAvg = null;
    let studentsInClass = null;
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
        if (allAvgs.length > 0) {
            highestAvg = Math.max(...allAvgs).toFixed(1);
            lowestAvg = Math.min(...allAvgs).toFixed(1);
        }
        studentsInClass = allAvgs.length;

        // Subject position logic
        if (true) {
             const subjectScores = {}; 
             for (const r of allClassResults) {
                 if (!subjectScores[r.subjectId]) subjectScores[r.subjectId] = [];
                 subjectScores[r.subjectId].push({ sid: r.studentProfileId, score: r.totalScore });
             }
             Object.values(subjectScores).forEach(arr => arr.sort((a,b) => b.score - a.score));
             enrichedResults.forEach(er => {
                 const ranks = subjectScores[er.subjectId];
                 if (ranks && ranks.length > 0) {
                     const r = ranks.findIndex(x => x.sid === studentProfileId);
                     if (r >= 0) er.subjectPosition = r + 1;
                     er.highestScore = ranks[0].score;
                     er.lowestScore = ranks[ranks.length - 1].score;
                     er.classAvgScore = Number((ranks.reduce((sum, item) => sum + item.score, 0) / ranks.length).toFixed(1));
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
        const { resultType: scaleResultType, assessmentType: scaleAssessmentType } = getGradingScaleType(req.query.resultType);
        const avgScore = totalScore / totalSubjects;
        const commentRules = await prisma.commentRule.findMany({
            where: { schoolId: req.user.schoolId, resultType: scaleAssessmentType }
        });
        
        let autoTeacherComment = '';
        let autoHeadComment = '';
        let autoPrincipalComment = '';
        let dynamicNarrativeComments = {};

        const matchedRules = commentRules.filter(r => avgScore >= r.minScore && avgScore <= r.maxScore);
        
        matchedRules.forEach(rule => {
            const role = rule.role;
            const comment = rule.comment;
            
            if (role === 'Class Teacher') autoTeacherComment = comment;
            if (role === 'Head Teacher') autoHeadComment = comment;
            if (role === 'Principal') autoPrincipalComment = comment;
            
            dynamicNarrativeComments[role] = comment;
            dynamicNarrativeComments[role.toUpperCase()] = comment;
            dynamicNarrativeComments[role.toLowerCase()] = comment;
        });

        if (!comments) {
            comments = { 
                teacherComment: autoTeacherComment, 
                principalComment: autoPrincipalComment, 
                headComment: autoHeadComment,
                narrativeComments: dynamicNarrativeComments
            };
        } else {
            // Forcefully apply auto comments if the setting is enabled
            if (autoTeacherComment) comments.teacherComment = autoTeacherComment;
            if (autoPrincipalComment) comments.principalComment = autoPrincipalComment;
            if (autoHeadComment) comments.headComment = autoHeadComment;
            
            let existingNarrative = comments.narrativeComments;
            if (typeof existingNarrative === 'string') {
                try { existingNarrative = JSON.parse(existingNarrative); } catch(e) { existingNarrative = {}; }
            }
            if (!existingNarrative || typeof existingNarrative !== 'object') existingNarrative = {};
            
            // Forcefully apply auto narrative comments if the setting is enabled
            Object.keys(dynamicNarrativeComments).forEach(role => {
                existingNarrative[role] = dynamicNarrativeComments[role];
            });
            comments.narrativeComments = existingNarrative;
        }
    }
    
    // Override attendance with manually entered data from comments if present
    // Also inject termRecord.daysOpened as the fallback for "opened/total" days.
    if (!attendance) {
        attendance = { opened: termRecord?.daysOpened || 0, present: 0, absent: 0, late: 0 };
        attendance.total = attendance.opened;
    } else {
        attendance.opened = termRecord?.daysOpened || attendance.total || 0;
        attendance.total = attendance.opened;
    }

    if (comments && (comments.total !== null || comments.present !== null)) {
        if (comments.total !== null) {
            attendance.total = comments.total;
            attendance.opened = comments.total;
        }
        if (comments.present !== null) {
            attendance.present = comments.present;
        }
        if (comments.absent !== null) {
            attendance.absent = comments.absent;
        }
    }

    // 10. School info
    const schoolInfo = await prisma.school.findUnique({
        where: { id: req.user.schoolId }
    });

    // 11. Cumulative / Annual logic
    let annualResults = [];
    let cumulativeAverage = null;

    if (term === 'Third Term' || req.query.isCumulative === 'true' || req.query.resultType === 'CUMULATIVE') {
        const allTerms = await prisma.academicTerm.findMany({
            where: { schoolId: req.user.schoolId, session: { name: academicYear } },
            orderBy: { createdAt: 'asc' }
        });
        
        const allTermsResults = await prisma.studentResult.findMany({
            where: { studentProfileId, academicYear, schoolId: req.user.schoolId },
            include: { subject: { select: { name: true, id: true } } }
        });

        const uniqueTermsFromResults = [...new Set(allTermsResults.map(r => r.term))];
        const termNames = allTerms.length > 0 ? allTerms.map(t => t.name) : uniqueTermsFromResults;

        const subjectMap = {};
        allTermsResults.forEach(r => {
             if (!subjectMap[r.subjectId]) {
                 subjectMap[r.subjectId] = { subject: r.subject, terms: {} };
             }
             subjectMap[r.subjectId].terms[r.term] = r.totalScore;
        });

        let cumTotal = 0, cumCount = 0;
        Object.values(subjectMap).forEach(sm => {
            let sum = 0, count = 0;
            termNames.forEach(tName => {
                if (sm.terms[tName] !== undefined && sm.terms[tName] !== null) {
                    sum += sm.terms[tName];
                    count++;
                }
            });
            
            if (count > 0) {
                 const avg = parseFloat((sum / termNames.length).toFixed(1));
                 cumTotal += avg; cumCount++;
                 sm.cumulative = avg;
                 const { grade, remark } = computeGrade(avg, grades);
                 sm.grade = grade;
                 sm.remark = remark;
                 annualResults.push(sm);
            }
        });
        if (cumCount > 0) cumulativeAverage = (cumTotal / cumCount).toFixed(1);
    }

    // 12. Trait Ratings
    let traits = await prisma.traitRating.findMany({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId }
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
            academicYear,
            photoUrl: student.profilePicture || null
        },
        results: enrichedResults,
        summary: {
            totalSubjects,
            totalScore,
            average,
            overallPosition,
            classAverage,
            highestAvg,
            lowestAvg,
            studentsInClass,
            passMark,
            cumulativeAverage,
            nextTermFee: student.classArm?.nextTermFee || null
        },
        visibleTypes: req.visibleTypes || ['CA', 'EXAM', 'FULL', 'COMMENT'],
          attendance,
          comments: comments || null,
          traits,
          annualResults,
          templateConfig,
          schoolSettings: schoolInfo ? (() => {
            let resultConfig = schoolSettingsRecord?.resultConfig || {};
            let sectionDisplay = resultConfig.display?.[sectionName] || resultConfig.display?.['ALL'] || {};
            if (!resultConfig.display?.['ALL'] && resultConfig.display) {
                if (Object.keys(resultConfig.display).some(k => ['showBorder', 'showStudentPicture'].includes(k))) sectionDisplay = resultConfig.display;
            }
            let sectionSignatures = resultConfig.signatures?.[sectionName] || resultConfig.signatures?.['ALL'] || [];
            if (!Array.isArray(sectionSignatures) && sectionSignatures.showSignature1 !== undefined) {
                 let legacySigs = [];
                 if (sectionSignatures.showSignature1) legacySigs.push({ id: 'sig1', roleName: sectionSignatures.signature1Label || 'Director', url: sectionSignatures.signature1Url });
                 if (sectionSignatures.showSignature2) legacySigs.push({ id: 'sig2', roleName: sectionSignatures.signature2Label || 'Principal', url: sectionSignatures.signature2Url });
                 sectionSignatures = legacySigs;
            }
            return {
                schoolName: schoolSettingsRecord?.schoolName || schoolInfo.name,
                address: schoolSettingsRecord?.address || schoolInfo.address,
                phone: schoolSettingsRecord?.phone || schoolInfo.phone,
                email: schoolSettingsRecord?.email || schoolInfo.email,
                logoUrl: schoolSettingsRecord?.logoUrl || schoolInfo.logoUrl,
                display: sectionDisplay,
                signatures: sectionSignatures,
                traitConfiguration: traitConfiguration,
                resultConfig: resultConfig
            };
        })() : null,
        gradingScale: { grades, passMark }
    });
};

const generateReportCardPDF = async (req, res) => {
    let { studentProfileId, term, academicYear, classId } = req.query;

    if (!term || !academicYear) {
        throw new CustomError.BadRequestError('term and academicYear are required');
    }

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

    const student = await prisma.studentProfile.findFirst({
        where: { id: studentProfileId, schoolId: req.user.schoolId },
        include: {
            user: { select: { name: true } },
            parent: { select: { fatherName: true, motherName: true } },
            classArm: { select: { name: true, level: true, id: true } }
        }
    });

    if (!student) throw new CustomError.NotFoundError('Student not found');

    // Override with historical class if enrolled for this specific term
    const termRecord2 = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });
    if (termRecord2) {
        const histEnroll = await prisma.studentTermEnrollment.findFirst({
            where: { schoolId: req.user.schoolId, studentProfileId, academicTermId: termRecord2.id },
            include: { class: { select: { name: true, level: true, id: true } } }
        });
        if (histEnroll && histEnroll.class) {
            student.classArm = histEnroll.class;
            student.classId = histEnroll.classId;
        }
    }

    const effectiveClassId = classId || student.classId;

    let results = await prisma.studentResult.findMany({
        where: { studentProfileId, term, academicYear, schoolId: req.user.schoolId },
        include: { subject: { select: { name: true, code: true, categoryId: true } } },
        orderBy: { subject: { name: 'asc' } }
    });

    if (student.subjectCategoryId) {
        results = results.filter(r => !r.subject.categoryId || r.subject.categoryId === student.subjectCategoryId);
    }

    const studentCategory = results[0]?.category || null;
    let gradingScaleRecord = null;
    const { resultType: scaleResultType, assessmentType: scaleAssessmentType } = getGradingScaleType(req.query.resultType);
    
    if (studentCategory) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: studentCategory, resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, category: 'ALL', resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, resultType: scaleResultType, assessmentType: scaleAssessmentType }
        });
    }
    const grades = gradingScaleRecord?.grades ?? [];
    const passMark = gradingScaleRecord?.passMark ?? 40;

    const enrichedResults = results.map(r => {
        const { grade, remark } = computeGrade(r.totalScore, grades);
        
        const scoresObj = typeof r.scores === 'string' ? JSON.parse(r.scores) : (r.scores || {});
        let ca1 = null, ca2 = null, ca3 = null, exam = null;
        
        for (const [k, v] of Object.entries(scoresObj)) {
            const key = k.toLowerCase();
            if (key.includes('1st ca') || key === 'ca1') ca1 = Number(v);
            else if (key.includes('2nd ca') || key === 'ca2') ca2 = Number(v);
            else if (key.includes('3rd ca') || key === 'ca3') ca3 = Number(v);
            else if (key.includes('exam')) exam = Number(v);
        }

        return {
            ...r,
            ca1,
            ca2,
            ca3,
            exam,
            computedGrade: grade,
            computedRemark: remark,
            isPassing: r.totalScore >= passMark
        };
    });

    const totalSubjects = enrichedResults.length;
    const totalScore = enrichedResults.reduce((sum, r) => sum + r.totalScore, 0);
    const average = totalSubjects > 0 ? (totalScore / totalSubjects).toFixed(1) : '0';

    const schoolSettingsRecord = await prisma.schoolSettings.findFirst({
        where: { schoolId: req.user.schoolId }
    });

    let classAverage = null;
    let highestAvg = null;
    let lowestAvg = null;
    let studentsInClass = null;
    let overallPosition = null;
    if (effectiveClassId) {
        const allClassResults = await prisma.studentResult.findMany({
            where: { classId: effectiveClassId, term, academicYear, schoolId: req.user.schoolId }
        });

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
        if (allAvgs.length > 0) {
            highestAvg = Math.max(...allAvgs).toFixed(1);
            lowestAvg = Math.min(...allAvgs).toFixed(1);
        }
        studentsInClass = allAvgs.length;
    }

    const schoolInfo = await prisma.school.findUnique({
        where: { id: req.user.schoolId }
    });

    const manualComment = await prisma.studentReportComment.findUnique({
        where: {
            schoolId_studentProfileId_term_academicYear: {
                schoolId: req.user.schoolId,
                studentProfileId,
                term,
                academicYear
            }
        }
    });

    let teacherComment = manualComment?.teacherComment || null;
    let principalComment = manualComment?.principalComment || null;

    if (schoolSettingsRecord?.resultAutomaticComments) {
        const { resultType: scaleResultType, assessmentType: scaleAssessmentType } = getGradingScaleType(req.query.resultType);
        const commentRules = await prisma.commentRule.findMany({
            where: { schoolId: req.user.schoolId, resultType: scaleAssessmentType }
        });
        const numericAverage = parseFloat(average);
        
        const matchedRules = commentRules.filter(r => numericAverage >= r.minScore && numericAverage <= r.maxScore);
        let dynamicNarrativeComments = {};

        matchedRules.forEach(rule => {
            const role = rule.role;
            const comment = rule.comment;
            
            if (role === 'Class Teacher') teacherComment = comment;
            if (role === 'Principal') principalComment = comment;
            
            dynamicNarrativeComments[role] = comment;
            dynamicNarrativeComments[role.toUpperCase()] = comment;
            dynamicNarrativeComments[role.toLowerCase()] = comment;
        });

        if (!manualComment) {
            manualComment = { narrativeComments: dynamicNarrativeComments };
        } else {
            let existingNarrative = manualComment.narrativeComments;
            if (typeof existingNarrative === 'string') {
                try { existingNarrative = JSON.parse(existingNarrative); } catch(e) { existingNarrative = {}; }
            }
            if (!existingNarrative || typeof existingNarrative !== 'object') existingNarrative = {};
            
            Object.keys(dynamicNarrativeComments).forEach(role => {
                existingNarrative[role] = dynamicNarrativeComments[role];
            });
            manualComment.narrativeComments = existingNarrative;
        }
    }

    const templateData = {
        school: {
            name: schoolSettingsRecord?.schoolName || schoolInfo?.name,
            motto: schoolSettingsRecord?.motto || schoolSettingsRecord?.tagline || "Knowledge and Integrity",
            address: schoolSettingsRecord?.address || schoolInfo?.address,
            phone: schoolSettingsRecord?.phone || schoolInfo?.phone,
            logoUrl: schoolSettingsRecord?.logoUrl || schoolInfo?.logoUrl
        },
        student: {
            name: student.user.name,
            admissionNo: student.admissionNo,
            class: student.classArm?.name || student.classLevel,
            noInClass: 30,
            nextTermFee: student.classArm?.nextTermFee || null,
            photoUrl: student.profilePicture || null
        },
        result: {
            term,
            academicYear,
            position: overallPosition ? `${overallPosition}` : '—',
            scores: enrichedResults.map(r => ({
                subject: r.subject.name,
                ca1: r.ca1,
                ca2: r.ca2,
                exam: r.exam,
                total: r.totalScore,
                grade: r.computedGrade,
                remark: r.computedRemark
            })),
            affectiveTraits: [],
            psychomotorTraits: [],
            comment: teacherComment,
            principalComment: principalComment,
            narrativeComments: manualComment?.narrativeComments || {}
        }
    };

    let sectionName = null;
    if (student.classArm && student.classArm.level) sectionName = student.classArm.level;
    const clsWithSection = await prisma.class.findUnique({ where: { id: effectiveClassId } });
    if (clsWithSection && clsWithSection.level) sectionName = clsWithSection.level;

    let activeTemplate = null;
    const requestedType = req.query.resultType || '';
    let dbTemplateType = 'SCORE_BASED';
    if (requestedType.includes('COMMENT')) dbTemplateType = 'COMMENT_BASED';
    else if (requestedType === 'TRANSCRIPT') dbTemplateType = 'TRANSCRIPT';

    if (sectionName) activeTemplate = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: sectionName, resultType: dbTemplateType }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    if (!activeTemplate) activeTemplate = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: null, resultType: dbTemplateType }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    const templateId = activeTemplate?.name || 'template1';
    const config = activeTemplate?.config || {};

    try {
        const pdfBuffer = await generateResultPDF(templateData, templateId, config);
        
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=result_${student.admissionNo}.pdf`,
            'Content-Length': pdfBuffer.length,
        });
        res.send(pdfBuffer);
    } catch (err) {
        console.error("PDF generation failed:", err);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ msg: 'Failed to generate PDF' });
    }
};

// ─── GET CLASS REPORT CARDS ───────────────────────────────────────────────────
const getClassReportCards = async (req, res) => {
    try {
        const { classId, term, academicYear } = req.query;

        if (!classId || !term || !academicYear) {
            throw new CustomError.BadRequestError('classId, term, and academicYear are required');
        }

        let students = [];
        const termRecord = await prisma.academicTerm.findFirst({
            where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
        });

        if (termRecord) {
            const enrollments = await prisma.studentTermEnrollment.findMany({
                where: { schoolId: req.user.schoolId, academicTermId: termRecord.id, classId },
                include: { student: { include: { user: { select: { name: true } } } } }
            });
            if (enrollments.length > 0) {
                students = enrollments.map(e => e.student).filter(s => s.status === 'Active' && !s.isDeleted);
            }
        }

        if (students.length === 0) {
            students = await prisma.studentProfile.findMany({
                where: { classId, schoolId: req.user.schoolId, isDeleted: false, status: 'Active' },
                include: { user: { select: { name: true } } },
                orderBy: { user: { name: 'asc' } }
            });
        } else {
            students.sort((a, b) => a.user.name.localeCompare(b.user.name));
        }

        // Determine the section for this class to pick the right 
        const classInfo = await prisma.class.findUnique({
            where: { id: classId },
            select: { section: true, nextTermFee: true }
        });

        let gradingScaleRecord = null;
        const { resultType: scaleResultType, assessmentType: scaleAssessmentType } = getGradingScaleType(req.query.resultType);
        
        if (classInfo?.section) {
            gradingScaleRecord = await prisma.gradingScale.findFirst({
                where: { schoolId: req.user.schoolId, category: classInfo.section, resultType: scaleResultType, assessmentType: scaleAssessmentType }
            });
        }
        if (!gradingScaleRecord) {
            gradingScaleRecord = await prisma.gradingScale.findFirst({
                where: { schoolId: req.user.schoolId, category: 'ALL', resultType: scaleResultType, assessmentType: scaleAssessmentType }
            });
        }
        if (!gradingScaleRecord) {
            gradingScaleRecord = await prisma.gradingScale.findFirst({
                where: { schoolId: req.user.schoolId, resultType: scaleResultType, assessmentType: scaleAssessmentType }
            });
        }
        const grades = gradingScaleRecord?.grades ?? [];
        const passMark = gradingScaleRecord?.passMark ?? 40;

        const [settings, rules] = await Promise.all([
            prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } }),
            prisma.commentRule.findMany({ where: { schoolId: req.user.schoolId, resultType: scaleAssessmentType } })
        ]);

        const summaries = await Promise.all(students.map(async (student) => {
            let results = await prisma.studentResult.findMany({
                where: { studentProfileId: student.id, term, academicYear, schoolId: req.user.schoolId },
                include: { subject: { select: { categoryId: true } } }
            });

            if (student.subjectCategoryId) {
                results = results.filter(r => !r.subject.categoryId || r.subject.categoryId === student.subjectCategoryId);
            }

            const totalScore = results.reduce((s, r) => s + r.totalScore, 0);
            const average = results.length > 0 ? (totalScore / results.length).toFixed(1) : '0';
            const subjectCount = results.length;
            const { grade } = computeGrade(parseFloat(average), grades);

            let comments = await prisma.studentReportComment.findFirst({
                where: { studentProfileId: student.id, term, academicYear, schoolId: req.user.schoolId }
            });

            const avgNum = parseFloat(average);
            let teacherComment = comments?.teacherComment || '';
            let headComment = comments?.headComment || '';
            let principalComment = comments?.principalComment || '';
            let existingNarrative = comments?.narrativeComments;
            
            if (typeof existingNarrative === 'string') {
                try { existingNarrative = JSON.parse(existingNarrative); } catch(e) { existingNarrative = {}; }
            }
            if (!existingNarrative || typeof existingNarrative !== 'object') existingNarrative = {};

            if (settings?.resultAutomaticComments) {
                const matchedRules = rules.filter(r => avgNum >= r.minScore && avgNum <= r.maxScore);
                
                matchedRules.forEach(rule => {
                    const role = rule.role;
                    const comment = rule.comment;
                    
                    if (role === 'Class Teacher') teacherComment = comment;
                    if (role === 'Head Teacher') headComment = comment;
                    if (role === 'Principal') principalComment = comment;
                    
                    existingNarrative[role] = comment;
                    existingNarrative[role.toUpperCase()] = comment;
                    existingNarrative[role.toLowerCase()] = comment;
                });
            }

            const returnComments = comments 
                ? { ...comments, teacherComment, headComment, principalComment, narrativeComments: existingNarrative } 
                : { teacherComment, headComment, principalComment, narrativeComments: existingNarrative };

            return {
                studentProfileId: student.id,
                admissionNo: student.admissionNo,
                name: student.user.name,
                gender: student.gender,
                photoUrl: student.profilePicture || null,
                subjectCount,
                totalScore,
                average,
                overallGrade: grade,
                comments: returnComments, // RETURN THE FULL COMMENT OBJECT (WITH AUTO GENERATED)
                isPassing: parseFloat(average) >= passMark
            };
        }));

        // Rank students
        const ranked = [...summaries].sort((a, b) => parseFloat(b.average) - parseFloat(a.average));
        ranked.forEach((s, idx) => { s.position = idx + 1; });

        res.status(StatusCodes.OK).json({ students: ranked, term, academicYear, classId });
    } catch (error) {
        console.error("Error in getClassReportCards:", error);
        res.status(500).json({ msg: "Internal Server Error", error: error.message });
    }
};

// ─── SAVE COMMENT ─────────────────────────────────────────────────────────────
const saveComment = async (req, res) => {
    const { studentProfileId, term, academicYear, comments, attendance } = req.body;
    
    const teacherComment = comments?.teacherComment || req.body.teacherComment;
    const headComment = comments?.headComment || req.body.headComment;
    const principalComment = comments?.principalComment || req.body.principalComment;
    const nextTermBegins = req.body.nextTermBegins;
    const promotedTo = req.body.promotedTo;
    const narrativeComments = req.body.narrativeComments;
    
    const present = attendance?.present !== undefined ? attendance.present : req.body.present;
    const absent = attendance?.absent !== undefined ? attendance.absent : req.body.absent;
    const total = attendance?.total !== undefined ? attendance.total : req.body.total;

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
        update: { teacherComment, headComment, principalComment, narrativeComments, nextTermBegins, promotedTo, present, absent, total },
        create: {
            schoolId: req.user.schoolId,
            studentProfileId,
            term,
            academicYear,
            teacherComment,
            headComment,
            principalComment,
            narrativeComments,
            nextTermBegins,
            promotedTo,
            present,
            absent,
            total
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Comment & Attendance saved', comment });
};

// ─── ADMIN: GET RESULTS FOR A CLASS (SCORE ENTRY) ────────────────────────────
const getAdminClassResults = async (req, res) => {
    const { classId, term, academicYear } = req.query;

    if (!classId || !term || !academicYear) {
        throw new CustomError.BadRequestError('classId, term, and academicYear are required');
    }

    let students = [];
    const termRecord = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });

    if (termRecord) {
        const enrollments = await prisma.studentTermEnrollment.findMany({
            where: { schoolId: req.user.schoolId, academicTermId: termRecord.id, classId },
            include: { student: { include: { user: { select: { name: true } } } } }
        });
        if (enrollments.length > 0) {
            students = enrollments.map(e => e.student).filter(s => !s.isDeleted);
        }
    }

    if (students.length === 0) {
        students = await prisma.studentProfile.findMany({
            where: { classId, schoolId: req.user.schoolId, isDeleted: false },
            include: { user: { select: { name: true } } },
            orderBy: { user: { name: 'asc' } }
        });
    } else {
        students.sort((a, b) => a.user.name.localeCompare(b.user.name));
    }

    let results = await prisma.studentResult.findMany({
        where: { classId, term, academicYear, schoolId: req.user.schoolId },
        include: { subject: { select: { name: true, code: true, categoryId: true } } }
    });

    results = results.filter(r => {
        const st = students.find(s => s.id === r.studentProfileId);
        if (!st) return false;
        if (st.subjectCategoryId) {
            return !r.subject.categoryId || r.subject.categoryId === st.subjectCategoryId;
        }
        return true;
    });

    const gradingScale = await prisma.gradingScale.findFirst({
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

    const schoolInfo = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
    const schoolSettingsRecord = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } });
    const school = {
        name: schoolSettingsRecord?.schoolName || schoolInfo?.name,
        logoUrl: schoolSettingsRecord?.logoUrl || schoolInfo?.logoUrl
    };

    // Get subjects taught in this class
    const { subjectId } = req.query;
    const classSubjectsRecords = await prisma.classSubject.findMany({
        where: { classId },
        include: { subject: { select: { id: true, name: true, code: true } } }
    });
    let classSubjects = classSubjectsRecords.map(cs => cs.subject).sort((a,b) => a.name.localeCompare(b.name));
    
    if (subjectId && subjectId !== 'ALL') {
        classSubjects = classSubjects.filter(s => s.id === subjectId);
    }

    // Get active students
    let students = [];
    const termRecord = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });

    if (termRecord) {
        const enrollments = await prisma.studentTermEnrollment.findMany({
            where: { schoolId: req.user.schoolId, academicTermId: termRecord.id, classId },
            include: { student: { include: { user: { select: { name: true } } } } }
        });
        if (enrollments.length > 0) {
            students = enrollments.map(e => e.student).filter(s => s.status === 'Active' && !s.isDeleted);
        }
    }

    if (students.length === 0) {
        students = await prisma.studentProfile.findMany({
            where: { classId, schoolId: req.user.schoolId, isDeleted: false, status: 'Active' },
            include: { user: { select: { name: true } } },
            orderBy: { user: { name: 'asc' } }
        });
    } else {
        students.sort((a, b) => a.user.name.localeCompare(b.user.name));
    }

    // Get all results
    let whereClause = { classId, term, academicYear, schoolId: req.user.schoolId };
    if (subjectId && subjectId !== 'ALL') {
        whereClause.subjectId = subjectId;
    }
    const results = await prisma.studentResult.findMany({
        where: whereClause,
        include: { subject: { select: { categoryId: true } } }
    });

    const validResults = results.filter(r => {
        const st = students.find(s => s.id === r.studentProfileId);
        if (!st) return false;
        if (st.subjectCategoryId) {
            return !r.subject.categoryId || r.subject.categoryId === st.subjectCategoryId;
        }
        return true;
    });

    let gradingScaleRecord = await prisma.gradingScale.findFirst({
        where: { schoolId: req.user.schoolId, category: classInfo.category || 'ALL', resultType: 'SCORE_BASED', assessmentType: 'EXAM' }
    });
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, resultType: 'SCORE_BASED', assessmentType: 'EXAM' }
        });
    }
    const grades = gradingScaleRecord ? gradingScaleRecord.grades : [];
    const passMark = gradingScaleRecord ? gradingScaleRecord.passMark : 40;

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

    for (const r of validResults) {
        if (broadsheetMap[r.studentProfileId]) {
            const { grade } = computeGrade(r.totalScore, grades);
            const rawScores = typeof r.scores === 'string' ? JSON.parse(r.scores) : (r.scores || {});
            broadsheetMap[r.studentProfileId].scores[r.subjectId] = {
                score: r.totalScore,
                grade: grade,
                breakdown: rawScores
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
        academicYear,
        passMark,
        school
    });
};

const getCumulativeBroadsheet = async (req, res) => {
    const { classId, academicYear } = req.query;

    if (!classId || !academicYear) {
        throw new CustomError.BadRequestError('classId and academicYear are required');
    }

    const classInfo = await prisma.class.findUnique({
        where: { id: classId, schoolId: req.user.schoolId }
    });
    if (!classInfo) {
        throw new CustomError.NotFoundError('Class not found');
    }

    const schoolInfo = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
    const schoolSettingsRecord = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } });
    const school = {
        name: schoolSettingsRecord?.schoolName || schoolInfo?.name,
        logoUrl: schoolSettingsRecord?.logoUrl || schoolInfo?.logoUrl
    };

    const students = await prisma.studentProfile.findMany({
        where: { classId, schoolId: req.user.schoolId, isDeleted: false, status: 'Active' },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } }
    });

    const results = await prisma.studentResult.findMany({
        where: { classId, academicYear, schoolId: req.user.schoolId }
    });

    const uniqueTerms = [...new Set(results.map(r => r.term))];

    const studentMap = {};
    for (const st of students) {
        studentMap[st.id] = {
            studentProfileId: st.id,
            name: st.user.name,
            admissionNo: st.admissionNo,
            gender: st.gender,
            terms: {},
            termAverages: {},
            cumTotal: 0,
            avg: 0
        };
    }

    for (const r of results) {
        if (studentMap[r.studentProfileId]) {
            if (!studentMap[r.studentProfileId].terms[r.term]) {
                studentMap[r.studentProfileId].terms[r.term] = { totalScore: 0, subjectCount: 0 };
            }
            studentMap[r.studentProfileId].terms[r.term].totalScore += r.totalScore;
            studentMap[r.studentProfileId].terms[r.term].subjectCount += 1;
        }
    }

    const broadsheetData = Object.values(studentMap).map(sb => {
        let sumAverages = 0;
        
        for (const term of uniqueTerms) {
            const termData = sb.terms[term];
            if (termData && termData.subjectCount > 0) {
                const termAvg = termData.totalScore / termData.subjectCount;
                sb.termAverages[term] = termAvg;
                sumAverages += termAvg;
            } else {
                sb.termAverages[term] = 0;
            }
        }
        
        sb.avg = uniqueTerms.length > 0 ? sumAverages / uniqueTerms.length : 0;
        sb.averageStr = sb.avg.toFixed(1);
        sb.cumTotal = Number(sumAverages.toFixed(1));
        return sb;
    }).sort((a, b) => b.avg - a.avg);

    let gradingScaleRecord = await prisma.gradingScale.findFirst({
        where: { schoolId: req.user.schoolId, category: classInfo.category || 'ALL', resultType: 'SCORE_BASED', assessmentType: 'EXAM' }
    });
    if (!gradingScaleRecord) {
        gradingScaleRecord = await prisma.gradingScale.findFirst({
            where: { schoolId: req.user.schoolId, resultType: 'SCORE_BASED', assessmentType: 'EXAM' }
        });
    }
    const grades = gradingScaleRecord ? gradingScaleRecord.grades : [];
    
    broadsheetData.forEach(sb => {
        const { grade, remark } = computeGrade(sb.avg, grades);
        sb.grade = grade;
        sb.remark = remark;
    });

    broadsheetData.forEach((st, idx) => st.position = idx + 1);

    res.status(StatusCodes.OK).json({
        classInfo,
        students: broadsheetData,
        uniqueTerms,
        academicYear,
        school
    });
};


// ─── PHASE 1: CORE INFRASTRUCTURE ENDPOINTS ──────────────────────────────────

const resultService = require('../services/result.service');

const computeClassResultsEndpoint = async (req, res) => {
    const { classId, term, academicYear } = req.body;
    if (!classId || !term || !academicYear) throw new CustomError.BadRequestError('classId, term, and academicYear are required');
    
    const result = await resultService.computeClassResults(req.user.schoolId, classId, term, academicYear);
    res.status(StatusCodes.OK).json(result);
};

const updateEntryStatus = async (req, res) => {
    const { classId, subjectId, term, academicYear, status, entryType } = req.body;
    if (!classId || !subjectId || !term || !academicYear || !status) throw new CustomError.BadRequestError('Missing required fields');

    const record = await prisma.subjectEntryStatus.upsert({
        where: {
            schoolId_classId_subjectId_term_academicYear: {
                schoolId: req.user.schoolId, classId, subjectId, term, academicYear
            }
        },
        update: { status, entryType, submittedAt: status === 'SUBMITTED' ? new Date() : null, submittedBy: req.user.userId },
        create: {
            schoolId: req.user.schoolId, classId, subjectId, term, academicYear, status, entryType,
            submittedAt: status === 'SUBMITTED' ? new Date() : null, submittedBy: req.user.userId
        }
    });
    res.status(StatusCodes.OK).json({ msg: 'Entry status updated', record });
};

const getSubjectEntryStatus = async (req, res) => {
    const { classId, term, academicYear } = req.query;
    if (!term || !academicYear) throw new CustomError.BadRequestError('term and academicYear are required');

    const whereClause = { schoolId: req.user.schoolId, term, academicYear };
    if (classId) {
        whereClause.classId = classId;
    }

    const statuses = await prisma.subjectEntryStatus.findMany({
        where: whereClause
    });
    res.status(StatusCodes.OK).json({ statuses });
};


const advancedUpdateReleaseStatus = async (req, res) => {
    const { classId, category, term, academicYear, isReleased, visibleTypes } = req.body;
    if (!term || !academicYear || typeof isReleased !== 'boolean') {
        throw new CustomError.BadRequestError('Missing term, academicYear, or isReleased');
    }

    let targetClasses = [];
    if (classId) {
        targetClasses = [{ id: classId }];
    } else if (category && category !== 'ALL') {
        targetClasses = await prisma.class.findMany({
            where: { schoolId: req.user.schoolId, classLevel: { name: category } },
            select: { id: true }
        });
    } else {
        targetClasses = await prisma.class.findMany({
            where: { schoolId: req.user.schoolId },
            select: { id: true }
        });
    }

    if (targetClasses.length === 0) return res.status(200).json({ msg: 'No classes found to update' });

    const results = [];
    for (const cls of targetClasses) {
        const record = await prisma.resultReleaseStatus.upsert({
            where: { schoolId_classId_term_academicYear: { schoolId: req.user.schoolId, classId: cls.id, term, academicYear } },
            update: { isReleased, visibleTypes: visibleTypes || ['CA', 'EXAM', 'FULL', 'COMMENT'], releasedAt: isReleased ? new Date() : null, releasedBy: req.user.userId },
            create: { schoolId: req.user.schoolId, classId: cls.id, term, academicYear, isReleased, visibleTypes: visibleTypes || ['CA', 'EXAM', 'FULL', 'COMMENT'], releasedAt: isReleased ? new Date() : null, releasedBy: req.user.userId }
        });
        results.push(record);
    }
    res.status(200).json({ msg: 'Release status updated for ' + results.length + ' classes' });
};

const getAdvancedReleaseStatus = async (req, res) => {
    const { classId, category, term, academicYear } = req.query;
    if (!term || !academicYear) throw new CustomError.BadRequestError('Missing term or academicYear');

    let targetClassId = classId;
    if (!targetClassId) {
        const whereClause = { schoolId: req.user.schoolId };
        if (category && category !== 'ALL') whereClause.classLevel = { name: category };
        const cls = await prisma.class.findFirst({ where: whereClause, select: { id: true } });
        if (cls) targetClassId = cls.id;
    }

    if (!targetClassId) return res.status(200).json({ status: { isReleased: false, visibleTypes: ['CA', 'EXAM', 'FULL', 'COMMENT'] } });

    const record = await prisma.resultReleaseStatus.findUnique({
        where: { schoolId_classId_term_academicYear: { schoolId: req.user.schoolId, classId: targetClassId, term, academicYear } }
    });

    res.status(200).json({ status: record || { isReleased: false, visibleTypes: ['CA', 'EXAM', 'FULL', 'COMMENT'] } });
};

const updateReleaseStatus = async (req, res) => {

    const { classId, term, academicYear, isReleased } = req.body;
    if (!classId || !term || !academicYear || typeof isReleased !== 'boolean') throw new CustomError.BadRequestError('Missing fields');

    const record = await prisma.resultReleaseStatus.upsert({
        where: {
            schoolId_classId_term_academicYear: { schoolId: req.user.schoolId, classId, term, academicYear }
        },
        update: { isReleased, releasedAt: isReleased ? new Date() : null, releasedBy: req.user.userId },
        create: {
            schoolId: req.user.schoolId, classId, term, academicYear, isReleased,
            releasedAt: isReleased ? new Date() : null, releasedBy: req.user.userId
        }
    });
    res.status(StatusCodes.OK).json({ msg: 'Release status updated', record });
};

const getTraitConfigurations = async (req, res) => {
    const category = req.query.category;
    let whereClause = { schoolId: req.user.schoolId };
    if (category) {
        whereClause.category = category;
    }
    const configs = await prisma.traitConfiguration.findMany({
        where: whereClause
    });
    res.status(StatusCodes.OK).json({ configs });
};

const saveTraitConfiguration = async (req, res) => {
    const { domain, traits, ratingScale, category = 'ALL' } = req.body;
    if (!domain || !traits || !ratingScale) throw new CustomError.BadRequestError('Missing fields');

    const config = await prisma.traitConfiguration.upsert({
        where: { schoolId_domain_category: { schoolId: req.user.schoolId, domain, category } },
        update: { traits, ratingScale },
        create: { schoolId: req.user.schoolId, domain, category, traits, ratingScale }
    });
    res.status(StatusCodes.OK).json({ msg: 'Configuration saved', config });
};

const deleteTraitConfiguration = async (req, res) => {
    const { domain, category = 'ALL' } = req.query;
    if (!domain) throw new CustomError.BadRequestError('Missing domain');

    await prisma.traitConfiguration.delete({
        where: { schoolId_domain_category: { schoolId: req.user.schoolId, domain, category } }
    }).catch(() => null); // ignore if doesn't exist
    
    res.status(StatusCodes.OK).json({ msg: 'Configuration deleted' });
};

const renameTraitConfiguration = async (req, res) => {
    const { oldDomain, newDomain, category = 'ALL' } = req.body;
    if (!oldDomain || !newDomain) throw new CustomError.BadRequestError('Missing oldDomain or newDomain');

    // Rename the TraitConfiguration
    await prisma.traitConfiguration.update({
        where: { schoolId_domain_category: { schoolId: req.user.schoolId, domain: oldDomain, category } },
        data: { domain: newDomain }
    }).catch((e) => {
        throw new CustomError.BadRequestError('Failed to rename or domain already exists');
    });

    // Rename existing ratings so they don't lose data
    await prisma.traitRating.updateMany({
        where: { schoolId: req.user.schoolId, domain: oldDomain },
        data: { domain: newDomain }
    });

    res.status(StatusCodes.OK).json({ msg: 'Configuration renamed' });
};

const getTraitRatings = async (req, res) => {
    const { classId, term, academicYear, domain } = req.query;
    if (!classId || !term || !academicYear || !domain) throw new CustomError.BadRequestError('Missing query params');

    const ratings = await prisma.traitRating.findMany({
        where: { schoolId: req.user.schoolId, classId, term, academicYear, domain }
    });
    res.status(StatusCodes.OK).json({ ratings });
};

const saveTraitRatings = async (req, res) => {
    const { classId, term, academicYear, domain, ratingsList } = req.body;
    // ratingsList = [{ studentProfileId, ratings: {} }]
    
    for (const r of ratingsList) {
        await prisma.traitRating.upsert({
            where: {
                schoolId_studentProfileId_domain_term_academicYear: {
                    schoolId: req.user.schoolId, studentProfileId: r.studentProfileId, domain, term, academicYear
                }
            },
            update: { ratings: r.ratings },
            create: { schoolId: req.user.schoolId, studentProfileId: r.studentProfileId, classId, domain, term, academicYear, ratings: r.ratings }
        });
    }
    res.status(StatusCodes.OK).json({ msg: 'Ratings saved' });
};

const getTemplatePreview = async (req, res) => {
    const { templateId, primaryColor, accentColor } = req.query;
    if (!templateId) throw new CustomError.BadRequestError('templateId is required');

    const pdfService = require('../services/pdf.service');
    let html = '';
    
    const data = {
        school: { name: "EXEMPLAR INTERNATIONAL SCHOOL", motto: "Knowledge and Integrity", address: "123 Education Lane, Lagos", phone: "+234 800 000 0000" },
        student: { name: "JOHN DOE", admissionNo: "ADM/2025/001", class: "JSS 1 Gold", noInClass: 30 },
        result: { 
            term: "2ND TERM", 
            academicYear: "2023/2024", 
            position: "1st", 
            scores: [
                { subject: "Mathematics", ca: 25, exam: 55, total: 80, grade: "A", remark: "Excellent", position: "1st", t1: 85, t2: 80, t3: 80, cumTotal: 245, cumAvg: 81.6, cumGrade: "A", cumPosition: "1st" },
                { subject: "English Language", ca: 20, exam: 50, total: 70, grade: "B", remark: "Very Good", position: "2nd", t1: 75, t2: 70, t3: 70, cumTotal: 215, cumAvg: 71.6, cumGrade: "B", cumPosition: "2nd" }
            ], 
            affectiveTraits: [], 
            psychomotorTraits: [],
            attendance: { opened: 100, present: 95, absent: 5 },
            summary: { obtainable: 1000, obtained: 800, percentage: 80 },
            gradingScale: [
                { grade: 'A', description: 'Excellent' },
                { grade: 'B', description: 'Very Good' },
                { grade: 'C', description: 'Good' },
                { grade: 'D', description: 'Fair' },
                { grade: 'F', description: 'Poor' }
            ]
        }
    };

    const config = {
        primaryColor: primaryColor || '#1f2937',
        accentColor: accentColor || '#1f2937'
    };

    if (templateId === 'template1') html = pdfService.template1(data, config);
    else if (templateId === 'template2') html = pdfService.template2(data, config);
    else if (templateId === 'template3') html = pdfService.template3(data, config);
    else if (templateId === 'template4') html = pdfService.template4(data, config);
    else if (templateId === 'template5') html = pdfService.template5(data, config);
    else throw new CustomError.BadRequestError('Invalid templateId');

    res.status(StatusCodes.OK).send(html);
};

const getAllTemplates = async (req, res) => {
    const templates = await prisma.resultTemplate.findMany({
        where: { schoolId: req.user.schoolId },
        orderBy: { createdAt: 'desc' }
    });
    res.status(StatusCodes.OK).json({ templates });
};

const assignTemplateSection = async (req, res) => {
    const { id } = req.params;
    const { sectionId, resultType } = req.body;
    
    const updateData = {};
    if (sectionId !== undefined) {
        updateData.assignedSectionId = sectionId === 'ALL' ? null : sectionId;
    }
    if (resultType !== undefined) {
        updateData.resultType = resultType;
    }

    const template = await prisma.resultTemplate.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: updateData
    });
    res.status(StatusCodes.OK).json({ msg: 'Template updated', template });
};

const getResultTemplate = async (req, res) => {
    const { classId } = req.query;
    let targetSection = null;
    if (classId) {
        const cls = await prisma.class.findUnique({ where: { id: classId }, include: { classLevel: true } });
        if (cls && cls.classLevel) targetSection = cls.classLevel.name;
    }
    let template = null;
    if (targetSection) template = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: targetSection }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    if (!template) template = await prisma.resultTemplate.findFirst({ where: { schoolId: req.user.schoolId, assignedSectionId: null }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    res.status(StatusCodes.OK).json({ template });
};

const createResultTemplate = async (req, res) => {
    const { name, config, resultType } = req.body;
    if (!name) throw new CustomError.BadRequestError('Template name is required');

    // Optionally set others to inactive if this is marked active, but let's just create it
    try {
        const template = await prisma.resultTemplate.create({
            data: { schoolId: req.user.schoolId, name, config, isActive: true, resultType: resultType || 'SCORE_BASED' }
        });
        
        await prisma.resultTemplate.updateMany({
            where: { schoolId: req.user.schoolId, id: { not: template.id } },
            data: { isActive: false }
        });

        res.status(StatusCodes.CREATED).json({ msg: 'Template created', template });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new CustomError.BadRequestError('A template with this name already exists.');
        }
        throw error;
    }
};

const updateResultTemplate = async (req, res) => {
    const { id } = req.params;
    const { name, config, isActive, resultType } = req.body;

    const template = await prisma.resultTemplate.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!template) throw new CustomError.NotFoundError('Template not found');

    try {
        const updated = await prisma.resultTemplate.update({
            where: { id },
            data: { 
                name: name || template.name, 
                config: config || template.config, 
                isActive: isActive !== undefined ? isActive : template.isActive,
                resultType: resultType || template.resultType
            }
        });

        if (isActive) {
            await prisma.resultTemplate.updateMany({
                where: { schoolId: req.user.schoolId, id: { not: id } },
                data: { isActive: false }
            });
        }

        res.status(StatusCodes.OK).json({ msg: 'Template updated', template: updated });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new CustomError.BadRequestError('A template with this name already exists.');
        }
        throw error;
    }
};

const deleteResultTemplate = async (req, res) => {
    const { id } = req.params;
    const template = await prisma.resultTemplate.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!template) throw new CustomError.NotFoundError('Template not found');

    await prisma.resultTemplate.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Template deleted' });
};

const getCommentRules = async (req, res) => {
    const { category, resultType } = req.query;
    const where = { schoolId: req.user.schoolId };
    if (category && category !== 'ALL') where.category = category;
    else where.category = null;
    if (resultType) where.resultType = resultType;
    const rules = await prisma.commentRule.findMany({ where, orderBy: [{ role: 'asc' }, { minScore: 'desc' }] });
    res.status(StatusCodes.OK).json({ rules });
};

const saveCommentRule = async (req, res) => {
    const { role, minScore, maxScore, comment, category, resultType } = req.body;
    if (!role || minScore === undefined || maxScore === undefined || !comment) throw new CustomError.BadRequestError('Missing fields');
    const rule = await prisma.commentRule.create({
        data: { schoolId: req.user.schoolId, role, minScore: parseFloat(minScore), maxScore: parseFloat(maxScore), comment, category: category === 'ALL' ? null : category, resultType: resultType || 'EXAM' }
    });
    res.status(StatusCodes.CREATED).json({ rule });
};

const deleteCommentRule = async (req, res) => {
    const { id } = req.params;
    const rule = await prisma.commentRule.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!rule) throw new CustomError.NotFoundError('Comment rule not found');
    await prisma.commentRule.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Rule deleted' });
};

const updateCommentRule = async (req, res) => {
    const { id } = req.params;
    const { role, minScore, maxScore, comment, category, resultType } = req.body;
    
    if (!role || minScore === undefined || maxScore === undefined || !comment) {
        throw new CustomError.BadRequestError('Missing fields');
    }
    
    const rule = await prisma.commentRule.update({
        where: { id, schoolId: req.user.schoolId },
        data: { 
            role, 
            minScore: parseFloat(minScore), 
            maxScore: parseFloat(maxScore), 
            comment, 
            category: category === 'ALL' ? null : category, 
            resultType: resultType || 'EXAM' 
        }
    });
    
    res.status(StatusCodes.OK).json({ rule });
};

const shareResultEndpoint = async (req, res) => {
    const { studentProfileId, term, academicYear, channel, recipient } = req.body;
    if (!studentProfileId || !term || !academicYear || !channel || !recipient) {
        throw new CustomError.BadRequestError('Missing required fields for sharing');
    }

    // Example URL for the parent to download
    const reportCardUrl = `http://localhost:3000/report-card/pdf?studentProfileId=${studentProfileId}&term=${term}&academicYear=${academicYear}`;

    const result = await shareResult(req.user.schoolId, studentProfileId, term, academicYear, channel, recipient, reportCardUrl);
    
    res.status(StatusCodes.OK).json({ msg: 'Result shared successfully', data: result });
};

// ─── PHASE 4: PRINT & EXPORT ────────────────────────────────────────────────

const generatePrintToken = async (req, res) => {
    const token = jwt.sign(
        { userId: req.user.userId, schoolId: req.user.schoolId, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );
    res.status(StatusCodes.OK).json({ token });
};

const validateResults = async (req, res) => {
    const { classId, term, academicYear } = req.query;
    if (!classId || !term || !academicYear) throw new CustomError.BadRequestError('Missing parameters');

    const termRecord = await prisma.academicTerm.findFirst({
        where: { schoolId: req.user.schoolId, name: term, session: { name: academicYear } }
    });
    if (!termRecord) return res.status(StatusCodes.OK).json({ warnings: ['Term not found.'] });

    const enrollments = await prisma.studentTermEnrollment.findMany({
        where: { schoolId: req.user.schoolId, academicTermId: termRecord.id, classId },
        include: { student: { include: { user: true } } }
    });

    const students = enrollments.map(e => e.student).filter(s => s.status === 'Active' && !s.isDeleted);
    
    const results = await prisma.studentResult.findMany({
        where: { schoolId: req.user.schoolId, classId, term, academicYear }
    });

    const warnings = [];

    students.forEach(student => {
        const studentResults = results.filter(r => r.studentProfileId === student.id);
        if (studentResults.length === 0) {
            warnings.push(`${student.user.name} (${student.admissionNo}): No results found.`);
        } else {
            studentResults.forEach(r => {
                if (r.totalScore === null || r.totalScore === undefined) {
                    warnings.push(`${student.user.name}: Missing total score.`);
                }
            });
        }
    });

    res.status(StatusCodes.OK).json({ warnings });
};

// ─── BATCH CACHE FOR BULK PRINT ────────────────────────────────────────────────
const crypto = require('crypto');
const batchCache = new Map();

const getBatchIds = async (req, res) => {
    const { batchId } = req.params;
    const ids = batchCache.get(batchId);
    if (!ids) {
        return res.status(404).json({ msg: 'Batch not found or expired' });
    }
    res.status(200).json({ studentIds: ids });
};

const batchExportPDF = async (req, res) => {
    const { studentIds, classId, term, academicYear, templateId, format } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        throw new CustomError.BadRequestError('No students selected for export');
    }

    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    
    const token = jwt.sign(
        { userId: req.user.userId, schoolId: req.user.schoolId, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );

    try {
        if (format === 'zip') {
            const jobs = studentIds.map(studentId => ({
                filename: `Result_${studentId}.pdf`,
                url: `${frontendUrl}/print-batch?studentIds=${studentId}&classId=${classId}&term=${encodeURIComponent(term)}&academicYear=${encodeURIComponent(academicYear)}&templateId=${templateId || ''}&resultType=${req.body.resultType || 'FULL'}&token=${token}`
            }));

            const pdfs = await generateDynamicPDFs(jobs);

            // Dynamically import ESM archiver module
            const archiverModule = await import('archiver');
            let archive;
            if (archiverModule.ZipArchive) {
                 archive = new archiverModule.ZipArchive({ zlib: { level: 9 } });
            } else {
                 const archiver = archiverModule.default || archiverModule;
                 archive = archiver('zip', { zlib: { level: 9 } });
            }
            res.attachment(`results_${classId}.zip`);
            archive.pipe(res);

            pdfs.forEach(pdfObj => {
                if (pdfObj && pdfObj.buffer) {
                    archive.append(pdfObj.buffer, { name: pdfObj.filename });
                }
            });

            await archive.finalize();

        } else {
            const batchId = crypto.randomBytes(16).toString('hex');
            batchCache.set(batchId, studentIds);
            setTimeout(() => batchCache.delete(batchId), 10 * 60 * 1000); // 10 minutes

            const url = `${frontendUrl}/print-batch?batchId=${batchId}&classId=${classId}&term=${encodeURIComponent(term)}&academicYear=${encodeURIComponent(academicYear)}&templateId=${templateId || ''}&resultType=${req.body.resultType || 'FULL'}&token=${token}`;
            
            const pdfBuffer = await generateDynamicPDF(url);

            res.set({
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="Class_Results.pdf"`,
                'Content-Length': pdfBuffer.length,
            });
            res.end(pdfBuffer);
        }
    } catch (err) {
        console.error("Batch Export Error:", err);
        require('fs').writeFileSync('batch-error.log', err.stack);
        throw new Error(`Failed to generate batch export: ${err.message}`);
    }
};

const getBatchReportCards = async (req, res) => {
    const { studentProfileIds, term, academicYear, classId, resultType, isCumulative } = req.query;
    if (!studentProfileIds || !term || !academicYear) {
        throw new CustomError.BadRequestError('studentProfileIds, term, and academicYear are required');
    }

    const ids = studentProfileIds.split(',').filter(Boolean);
    
    // We will execute the exact logic of getStudentReportCard for each ID in parallel
    // by manually constructing mock req/res objects, or factoring out the core logic.
    // Factoring out is safer. Let's just do Promise.all over the internal logic.
    
    try {
        const results = await Promise.all(ids.map(async (id) => {
            // Build mock req and res
            const mockReq = {
                user: req.user,
                query: { studentProfileId: id, term, academicYear, classId, resultType, isCumulative }
            };
            
            let responseData = null;
            let responseStatus = 200;
            
            const mockRes = {
                status: (code) => {
                    responseStatus = code;
                    return mockRes;
                },
                json: (data) => {
                    responseData = data;
                }
            };

            // Assuming getStudentReportCard handles async and populates mockRes
            // We need to catch errors thrown inside it
            try {
                await getStudentReportCard(mockReq, mockRes);
                return responseData;
            } catch (err) {
                console.error(`Error fetching report card for ${id}:`, err);
                return null;
            }
        }));

        res.status(StatusCodes.OK).json({ data: results.filter(Boolean) });
    } catch (error) {
         console.error("Batch Report Cards Error:", error);
         res.status(500).json({ msg: 'Failed to fetch batch report cards' });
    }
};

module.exports = {
    getGradingScale,
    saveGradingScale,
    getStudentReportCard,
    getClassReportCards,
    saveComment,
    getAdminClassResults,
    getBroadsheet,
    computeClassResultsEndpoint,
    updateEntryStatus,
    getSubjectEntryStatus,
    updateReleaseStatus,
    advancedUpdateReleaseStatus,
    getAdvancedReleaseStatus,
    getTraitConfigurations,
    saveTraitConfiguration,
    getTraitRatings,
    saveTraitRatings,
    getCumulativeBroadsheet,
    generateReportCardPDF,
    getTemplatePreview,
    getAllTemplates,
    createResultTemplate,
    updateResultTemplate,
    deleteResultTemplate,
    getResultTemplate,
    assignTemplateSection,
    getCommentRules,
    saveCommentRule,
    updateCommentRule,
    deleteCommentRule,
    shareResultEndpoint,
    generatePrintToken,
    validateResults,
    batchExportPDF,
    getBatchIds,
    getBatchReportCards,
    deleteTraitConfiguration,
    renameTraitConfiguration
};
