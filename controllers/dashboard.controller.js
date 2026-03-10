
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')

const getDashboardStats = async (req, res) => {
    const { userId, role } = req.user

    switch (role) {
        case 'STUDENT': {
            const student = await prisma.studentProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { email: true } },
                    classArm: true,
                }
            })

            if (!student) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Student profile not found' })

            const stats = {
                cgpa: '0.00',
                outstandingCourses: 0,
                creditUnits: 0,
                walletBalance: '₦0.00',
            }

            return res.status(StatusCodes.OK).json({ profile: student, stats })
        }

        case 'TEACHER': {
            const teacher = await prisma.teacherProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { name: true, email: true } }
                }
            })

            if (!teacher) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Teacher profile not found' })

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
                    where: { classId: { in: assignedClassIds }, status: 'Active' }
                });
            } else if (timetableClassNames.length > 0) {
                // Fallback: match by classLevel string if no classId-based assignments yet
                totalStudents = await prisma.studentProfile.count({
                    where: { classLevel: { in: timetableClassNames }, status: 'Active' }
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
                    where: { classId: { in: assignedClassIds }, status: 'Active' },
                    include: {
                        user: { select: { name: true } },
                        classArm: { select: { name: true } }
                    },
                    take: 5
                });
            } else if (timetableClassNames.length > 0) {
                rawStudents = await prisma.studentProfile.findMany({
                    where: { classLevel: { in: timetableClassNames }, status: 'Active' },
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

            return res.status(StatusCodes.OK).json({ profile: teacher, stats, schedule, recentStudents })
        }

        case 'PARENT': {
            const parent = await prisma.parentProfile.findUnique({
                where: { userId },
                include: {
                    user: { select: { email: true } },
                    children: {
                        include: { classArm: true }
                    }
                }
            })

            if (!parent) return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Parent profile not found' })

            const outstandingFees = 0

            const stats = {
                childrenCount: parent.children.length,
                outstandingFees: `₦${outstandingFees}`,
                avgCgpa: '0.00',
                notifications: 0
            }

            return res.status(StatusCodes.OK).json({ profile: parent, stats, children: parent.children, recentFees: [] })
        }

        case 'ADMIN': {
            // High-level admin overview for this specific school
            const stats = {
                totalStudents: await prisma.studentProfile.count({ where: { schoolId: req.user.schoolId, status: 'Active' } }),
                totalTeachers: await prisma.teacherProfile.count({ where: { schoolId: req.user.schoolId, status: 'Active' } }),
                totalParents: await prisma.parentProfile.count({ where: { schoolId: req.user.schoolId } }),
                totalClasses: await prisma.class.count({ where: { schoolId: req.user.schoolId, status: 'Active' } })
            }
            return res.status(StatusCodes.OK).json({ stats })
        }

        default:
            return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Invalid role' })
    }
}

module.exports = { getDashboardStats }
