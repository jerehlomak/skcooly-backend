const prisma = require('../db/prisma');

/**
 * Helper to compute grade and remark from a total score
 */
const computeGrade = (totalScore, grades) => {
    if (!grades || !Array.isArray(grades) || grades.length === 0) return { grade: '-', remark: '-', status: '-' };
    const sorted = [...grades].sort((a, b) => Number(b.minScore) - Number(a.minScore));
    for (const g of sorted) {
        if (totalScore >= Number(g.minScore) && totalScore <= Number(g.maxScore)) {
            return { grade: g.grade, remark: g.remark || '-', status: g.status || 'PASS' };
        }
    }
    return { grade: 'F', remark: 'Fail', status: 'FAIL' };
};

/**
 * Calculates results for an entire class for a specific term and year
 */
const computeClassResults = async (schoolId, classId, term, academicYear) => {
    // 1. Fetch all student results for this class
    const results = await prisma.studentResult.findMany({
        where: { schoolId, classId, term, academicYear, isDeleted: false }
    });

    if (results.length === 0) return { success: true, message: 'No results to compute' };

    // 2. Determine category/section for this class
    const classInfo = await prisma.class.findUnique({
        where: { id: classId, schoolId },
        select: { level: true, section: true }
    });
    
    let gradingScale = await prisma.gradingScale.findFirst({
        where: { schoolId, category: `CLASS_${classId}` }
    });
    if (!gradingScale && classInfo?.section) {
        gradingScale = await prisma.gradingScale.findFirst({
            where: { schoolId, category: classInfo.section }
        });
    }
    if (!gradingScale) {
        gradingScale = await prisma.gradingScale.findFirst({
            where: { schoolId, category: 'ALL' }
        });
    }
    const grades = gradingScale?.grades || [];
    const passMark = gradingScale?.passMark || 40;
    
    // 3. Compute Subject Positions
    const subjectScores = {}; // subjectId -> [{ id, score }]
    for (const r of results) {
        if (!subjectScores[r.subjectId]) subjectScores[r.subjectId] = [];
        subjectScores[r.subjectId].push({ id: r.id, score: r.totalScore });
    }

    // Prepare updates
    const resultUpdates = [];
    Object.keys(subjectScores).forEach(subjectId => {
        const scores = subjectScores[subjectId].sort((a, b) => b.score - a.score);
        let currentRank = 1;
        let skip = 0;
        let prevScore = null;

        for (let i = 0; i < scores.length; i++) {
            if (prevScore !== null && scores[i].score === prevScore) {
                skip++;
            } else {
                currentRank += skip;
                skip = 1;
                prevScore = scores[i].score;
            }
            const { grade, remark, status } = computeGrade(scores[i].score, grades);
            resultUpdates.push(
                prisma.studentResult.update({
                    where: { id: scores[i].id },
                    data: { grade, subjectPosition: currentRank }
                })
            );
        }
    });

    // 4. Compute Overall Class Positions
    const studentTotals = {};
    for (const r of results) {
        if (!studentTotals[r.studentProfileId]) {
            studentTotals[r.studentProfileId] = {
                studentProfileId: r.studentProfileId,
                totalScore: 0,
                subjectCount: 0
            };
        }
        studentTotals[r.studentProfileId].totalScore += r.totalScore;
        studentTotals[r.studentProfileId].subjectCount++;
    }

    const students = Object.values(studentTotals).map(s => {
        s.average = s.subjectCount > 0 ? parseFloat((s.totalScore / s.subjectCount).toFixed(1)) : 0;
        return s;
    });

    // Sort by average to determine class position
    students.sort((a, b) => b.average - a.average);
    let classRank = 1;
    let classSkip = 0;
    let prevAvg = null;

    const termUpdates = [];
    for (let i = 0; i < students.length; i++) {
        const s = students[i];
        if (prevAvg !== null && s.average === prevAvg) {
            classSkip++;
        } else {
            classRank += classSkip;
            classSkip = 1;
            prevAvg = s.average;
        }

        const overallStatus = s.average >= passMark ? 'PASS' : 'FAIL';

        termUpdates.push(
            prisma.studentTermResult.upsert({
                where: {
                    studentProfileId_term_academicYear: {
                        studentProfileId: s.studentProfileId,
                        term,
                        academicYear
                    }
                },
                update: {
                    totalScore: s.totalScore,
                    average: s.average,
                    position: classRank,
                    status: overallStatus
                },
                create: {
                    schoolId,
                    studentProfileId: s.studentProfileId,
                    classId,
                    term,
                    academicYear,
                    totalScore: s.totalScore,
                    average: s.average,
                    position: classRank,
                    status: overallStatus
                }
            })
        );
    }

    // Run all updates in transaction
    await prisma.$transaction([...resultUpdates, ...termUpdates]);

    return { success: true, message: 'Computed results successfully' };
};

/**
 * Service function to get enriched report card data for a single student
 */
const getEnrichedStudentReport = async (studentProfileId, term, academicYear, classId, schoolId) => {
    // This will encapsulate the logic from result.controller.js if needed
    return {};
};

module.exports = {
    computeGrade,
    computeClassResults,
    getEnrichedStudentReport
};
