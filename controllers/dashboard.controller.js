
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')

const getDashboardStats = async (req, res) => {
    const { userId, role } = req.user

    switch (role) {
        case 'STUDENT': {
            const student = await prisma.studentProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { name: true, email: true } },
                    classArm: true,
                }
            })

            if (!student) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Student profile not found' })

            const school = await prisma.school.findUnique({
                where: { id: student.schoolId },
                select: { name: true }
            })

            const stats = {
                cgpa: '0.00',
                outstandingCourses: 0,
                creditUnits: 0,
                walletBalance: '₦0.00',
            }

            return res.status(StatusCodes.OK).json({ 
                profile: { ...student, school }, 
                stats 
            })
        }

        case 'TEACHER': {
            const teacher = await prisma.teacherProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { name: true, email: true } }
                }
            })

            if (!teacher) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Teacher profile not found' })

            const school = await prisma.school.findUnique({
                where: { id: teacher.schoolId },
                select: { name: true }
            })

            // ── Find classes via per-class ClassSubject.teacherId assignment (new system) ──
            const classSubjectsAssigned = await prisma.classSubject.findMany({
                where: { teacherId: teacher.id },
                include: {
                    class: true,
                    subject: true
                }
            });

            const assignedClassIds = [...new Set(classSubjectsAssigned.map(cs => cs.classId))];
            const assignedClassObjs = await prisma.class.findMany({
                where: { id: { in: assignedClassIds } }
            });

            // Also include classes from Timetable entries (legacy / manually scheduled)
            const existingSlots = await prisma.timetableEntry.findMany({
                where: { OR: [{ teacherId: teacher.id }, { teacherName: teacher.user.name }] },
                select: { classId: true, subject: true }
            });
            const timetableClassNames = [...new Set(existingSlots.map(s => s.classId))];

            const classesAssigned = Math.max(assignedClassObjs.length, timetableClassNames.length);

            // Subjects: unique subjects from ClassSubject assignments
            const subjectNames = [...new Set(classSubjectsAssigned.map(cs => cs.subject.name))];
            const subjectsTeaching = subjectNames.length > 0
                ? subjectNames.length
                : [...new Set(existingSlots.map(s => s.subject))].length;

            // Total Students: count by classId (specific arm) for assigned classes
            let totalStudents = 0;
            if (assignedClassIds.length > 0) {
                totalStudents = await prisma.studentProfile.count({
                    where: { classId: { in: assignedClassIds }, status: 'Active', isDeleted: false }
                });
            } else if (timetableClassNames.length > 0) {
                // Fallback: match by classLevel string if no classId-based assignments yet
                totalStudents = await prisma.studentProfile.count({
                    where: { classLevel: { in: timetableClassNames }, status: 'Active', isDeleted: false }
                });
            }

            // Today's schedule
            const daysMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const todayStr = daysMap[new Date().getDay()];
            const todaySlots = await prisma.timetableEntry.findMany({
                where: { OR: [{ teacherId: teacher.id }, { teacherName: teacher.user.name }], day: todayStr },
                orderBy: { period: 'asc' }
            });

            // Build a map of classId → display name (for timetable slots)
            const classNameMap = {};
            assignedClassObjs.forEach(c => {
                classNameMap[c.id] = c.name;
                classNameMap[c.name] = c.name; // also map name → name for string-keyed entries
            });

            const schedule = todaySlots.map(slot => ({
                subject: slot.subject,
                class: classNameMap[slot.classId] || slot.classId,
                room: 'Classroom',
                time: slot.period
            }));

            // Recent Students: query by classId for assigned arms
            let rawStudents = [];
            if (assignedClassIds.length > 0) {
                rawStudents = await prisma.studentProfile.findMany({
                    where: { classId: { in: assignedClassIds }, status: 'Active', isDeleted: false },
                    include: {
                        user: { select: { name: true } },
                        classArm: { select: { name: true } }
                    },
                    take: 5
                });
            } else if (timetableClassNames.length > 0) {
                rawStudents = await prisma.studentProfile.findMany({
                    where: { classLevel: { in: timetableClassNames }, status: 'Active', isDeleted: false },
                    include: {
                        user: { select: { name: true } },
                        classArm: { select: { name: true } }
                    },
                    take: 5
                });
            }

            const recentStudents = rawStudents.map(s => ({
                name: s.user.name,
                class: s.classArm?.name || s.classLevel, // Show arm name (JSS1A) not generic level
                attendance: Math.floor(Math.random() * 21) + 80,
                grade: ['A', 'B', 'B+', 'A-'][Math.floor(Math.random() * 4)]
            }));

            const stats = {
                classesAssigned,
                subjectsTeaching,
                totalStudents,
                assignmentsPending: 0
            }

            return res.status(StatusCodes.OK).json({ profile: { ...teacher, school }, stats, schedule, recentStudents })
        }

        case 'PARENT': {
            const parent = await prisma.parentProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { name: true, email: true } },
                    students: {
                        include: {
                            user: { select: { name: true } },
                            classArm: { select: { name: true, level: true } }
                        }
                    }
                }
            })

            if (!parent) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Parent profile not found' })

            const school = await prisma.school.findUnique({
                where: { id: parent.schoolId },
                select: { name: true }
            })

            // Calculate REAL outstanding fees from the database
            const studentIds = parent.students.map(s => s.id);
            let outstandingAmount = 0;
            let recentFees = [];

            if (studentIds.length > 0) {
                const invoices = await prisma.feeInvoice.findMany({
                    where: { schoolId: parent.schoolId, studentProfileId: { in: studentIds }, isDeleted: false },
                    include: { student: { include: { user: { select: { name: true } } } } },
                    orderBy: { createdAt: 'desc' },
                    take: 5
                });
                outstandingAmount = invoices.reduce((sum, inv) => sum + (inv.totalAmount - inv.amountPaid), 0);
                recentFees = invoices.map(inv => ({
                    desc: `${inv.term} ${inv.year} — ${inv.student.user.name}`,
                    date: inv.createdAt.toISOString().split('T')[0],
                    status: inv.status,
                    amount: `₦${inv.totalAmount.toLocaleString('en-NG')}`
                }));
            }

            // Shape children for the frontend (using `name` not `firstName/lastName`)
            const children = parent.students.map(s => ({
                id: s.id,
                firstName: s.user.name.split(' ')[0],
                lastName: s.user.name.split(' ').slice(1).join(' '),
                name: s.user.name,
                admissionNumber: s.admissionNo,
                classLevel: s.classArm || { name: s.classLevel },
                isActive: s.status === 'Active',
                photo: null
            }));

            const stats = {
                childrenCount: children.length,
                outstandingFees: outstandingAmount > 0 ? `₦${outstandingAmount.toLocaleString('en-NG')}` : '₦0.00',
                avgCgpa: '0.00',
                notifications: 0
            }

            return res.status(StatusCodes.OK).json({ profile: { ...parent, school }, stats, children, recentFees })
        }

        case 'ADMIN': {
            // High-level admin overview for this specific school
            const stats = {
                totalStudents: await prisma.studentProfile.count({ where: { schoolId: req.user.schoolId, status: 'Active', isDeleted: false } }),
                totalTeachers: await prisma.teacherProfile.count({ where: { schoolId: req.user.schoolId, status: 'Active', isDeleted: false } }),
                totalParents: await prisma.parentProfile.count({ where: { schoolId: req.user.schoolId, isDeleted: false } }),
                totalClasses: await prisma.class.count({ where: { schoolId: req.user.schoolId, status: 'Active', isDeleted: false } })
            }
            return res.status(StatusCodes.OK).json({ stats })
        }

        default:
            return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Invalid role' })
    }
}

const getMyResults = async (req, res) => {
    const { userId, role } = req.user;
    const { term, academicYear } = req.query;

    if (role !== 'STUDENT') {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Only students can view their direct results here' });
    }

    if (!term || !academicYear) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Please provide term and academicYear' });
    }

    const student = await prisma.studentProfile.findUnique({
        where: { userId },
        include: { user: { select: { name: true } }, classArm: true }
    });

    if (!student) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Student not found' });

    // Fetch this student's results for the selected term
    const rawResults = await prisma.studentResult.findMany({
        where: { studentProfileId: student.id, term, academicYear, isDeleted: false },
        include: { subject: { select: { name: true } } }
    });

    if (rawResults.length === 0) {
        return res.status(StatusCodes.OK).json({ results: [], summary: null, assessmentKeys: [] });
    }

    // Fetch the canonical AssessmentStructure for this student's category
    const category = student.classArm?.level || student.classLevel || 'JSS';
    const structure = await prisma.assessmentStructure.findFirst({
        where: { schoolId: student.schoolId, category, isDeleted: false }
    });

    let assessmentKeys = [];
    if (structure && structure.parts) {
        assessmentKeys = structure.parts.map(p => p.name);
    } else {
        // Fallback: guess keys from the first result
        assessmentKeys = Object.keys(rawResults[0].scores || {});
    }

    // Sort to try and put 'Exam' at the end
    assessmentKeys.sort((a, b) => {
        if (a.toLowerCase().includes('exam')) return 1;
        if (b.toLowerCase().includes('exam')) return -1;
        return 0;
    });

    // Fetch ALL results for this class + term + year to calculate Positions and Highest in Class
    const classResults = await prisma.studentResult.findMany({
        where: { classId: rawResults[0].classId, term, academicYear, isDeleted: false }
    });

    // Calculate Highest in Class for each subject
    const subjectHighest = {};
    const classTotalsByStudent = {};

    classResults.forEach(r => {
        if (!subjectHighest[r.subjectId] || r.totalScore > subjectHighest[r.subjectId]) {
            subjectHighest[r.subjectId] = Math.round(r.totalScore);
        }

        if (!classTotalsByStudent[r.studentProfileId]) {
            classTotalsByStudent[r.studentProfileId] = { total: 0, count: 0 };
        }
        classTotalsByStudent[r.studentProfileId].total += r.totalScore;
        classTotalsByStudent[r.studentProfileId].count += 1;
    });

    // Calculate term averages for rank
    const classAverages = Object.entries(classTotalsByStudent).map(([id, data]) => ({
        studentProfileId: id,
        average: data.count > 0 ? (data.total / data.count) : 0
    }));
    classAverages.sort((a, b) => b.average - a.average);
    
    const myRankIndex = classAverages.findIndex(s => s.studentProfileId === student.id);
    const classPos = myRankIndex !== -1 ? myRankIndex + 1 : 0;
    const classTotal = classAverages.length;

    const getRemark = (score) => {
        if (score >= 70) return 'Excellent';
        if (score >= 60) return 'Very Good';
        if (score >= 50) return 'Good';
        if (score >= 45) return 'Pass';
        if (score >= 40) return 'Weak Pass';
        return 'Fail';
    };

    let totalScore = 0;
    const formattedResults = rawResults.map(r => {
        const dynamicScores = {};
        
        // Extract scores based exactly on what the assessmentKeys demand
        if (structure && structure.parts) {
            structure.parts.forEach(part => {
                // The DB saves scores using the part.id as the JSON key (e.g. { "1773409874376": 50 })
                // We map it to part.name for the UI (e.g. { "1st CA": 50 })
                dynamicScores[part.name] = Number(r.scores[part.id] || r.scores[part.name] || 0);
            });
        } else {
            assessmentKeys.forEach(key => {
                dynamicScores[key] = Number(r.scores[key] || 0);
            });
        }

        const total = Math.round(r.totalScore);
        totalScore += total;

        const subjectScores = classResults.filter(cr => cr.subjectId === r.subjectId).map(cr => cr.totalScore).sort((a,b)=>b-a);
        const subjectPos = subjectScores.indexOf(r.totalScore) + 1;

        return {
            subject: r.subject.name,
            scores: dynamicScores,
            total,
            grade: r.grade || 'F',
            remark: getRemark(total),
            position: subjectPos,
            highest: subjectHighest[r.subjectId] || total
        };
    });

    const average = rawResults.length > 0 ? Math.round(totalScore / rawResults.length) : 0;

    // Advanced: Third Term Cumulative & Promotion Logic
    let cumulativeAverage = null;
    let promoted = null;
    let principalRemark = "";

    if (term === 'Third Term') {
        const allTerms = await prisma.studentResult.findMany({
            where: { studentProfileId: student.id, academicYear, isDeleted: false }
        });

        if (allTerms.length > 0) {
            const grandTotal = allTerms.reduce((sum, r) => sum + r.totalScore, 0);
            cumulativeAverage = Math.round(grandTotal / allTerms.length);
            promoted = cumulativeAverage >= 40; 
            
            if (promoted) {
                principalRemark = `Congratulations! You have been promoted to the next class with a cumulative average of ${cumulativeAverage}%.`;
            } else {
                principalRemark = `Unfortunately, you have not met the requirements for promotion. Cumulative average: ${cumulativeAverage}%. Advised to repeat.`;
            }
        }
    } else {
        if (average >= 70) principalRemark = "An outstanding result, keep up the excellent work!";
        else if (average >= 50) principalRemark = "A satisfactory performance, but there is room for improvement.";
        else principalRemark = "A poor performance. Significant improvement is required next term.";
    }

    const summary = {
        totalScore,
        average,
        classPos,
        classTotal,
        distinctions: formattedResults.filter(r => r.grade === 'A').length,
        cumulativeAverage,
        promoted,
        principalRemark
    };

    return res.status(StatusCodes.OK).json({
        student: {
            name: student.user.name,
            admissionNo: student.admissionNo,
            class: student.classArm?.name || student.classLevel,
            academicYear,
            term,
            photo: req.user.photo // Passed down from auth
        },
        results: formattedResults,
        summary,
        assessmentKeys
    });
};

module.exports = { getDashboardStats, getMyResults };
