const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── ATTENDANCE ────────────────────────────────────────────────────────────────

/**
 * Get today's KPI stats for the overview dashboard
 */
const getAttendanceStats = async (req, res) => {
    const { date, classId } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const where = { date: targetDate };
    if (classId) where.classId = classId;

    const [present, absent, late, excused, allStudents] = await Promise.all([
        prisma.attendanceRecord.count({ where: { ...where, status: 'PRESENT', student: { schoolId: req.user.schoolId } } }),
        prisma.attendanceRecord.count({ where: { ...where, status: 'ABSENT', student: { schoolId: req.user.schoolId } } }),
        prisma.attendanceRecord.count({ where: { ...where, status: 'LATE', student: { schoolId: req.user.schoolId } } }),
        prisma.attendanceRecord.count({ where: { ...where, status: 'EXCUSED', student: { schoolId: req.user.schoolId } } }),
        classId
            ? prisma.studentProfile.count({ where: { classId, status: 'Active', schoolId: req.user.schoolId } })
            : prisma.studentProfile.count({ where: { status: 'Active', schoolId: req.user.schoolId } }),
    ]);

    res.status(StatusCodes.OK).json({
        date: targetDate,
        totalStudents: allStudents,
        present, absent, late, excused,
        markedCount: present + absent + late + excused,
    });
};

/**
 * Get attendance records for a class on a specific date
 */
const getAttendanceRoster = async (req, res) => {
    const { classId, date } = req.query;
    if (!classId || !date) throw new CustomError.BadRequestError('classId and date are required');

    // Students in this class arm
    const students = await prisma.studentProfile.findMany({
        where: { classId, status: 'Active', schoolId: req.user.schoolId },
        include: { user: { select: { name: true } } },
        orderBy: { admissionNo: 'asc' },
    });

    // Existing records for that date
    const records = await prisma.attendanceRecord.findMany({
        where: { classId, date },
    });

    const recordMap = Object.fromEntries(records.map(r => [r.studentProfileId, r]));

    const roster = students.map(s => ({
        studentId: s.id,
        name: s.user.name,
        admissionNo: s.admissionNo,
        gender: s.gender,
        record: recordMap[s.id] || null,
    }));

    res.status(StatusCodes.OK).json({ date, classId, roster });
};

/**
 * Mark attendance for a full class (bulk upsert)
 * Body: { classLevel, date, records: [{ studentId, status, note }] }
 */
const markAttendance = async (req, res) => {
    const { classId, date, records } = req.body;
    const { name } = req.user;

    if (!classId || !date || !Array.isArray(records) || records.length === 0) {
        throw new CustomError.BadRequestError('classId, date, and records array are required');
    }

    const upserts = records.map(r =>
        prisma.attendanceRecord.upsert({
            where: { studentProfileId_date: { studentProfileId: r.studentId, date } },
            create: {
                studentProfileId: r.studentId,
                date,
                classId,
                status: r.status || 'PRESENT',
                note: r.note || null,
                markedBy: name,
            },
            update: {
                classId,
                status: r.status || 'PRESENT',
                note: r.note || null,
                markedBy: name,
            },
        })
    );

    const results = await prisma.$transaction(upserts);
    res.status(StatusCodes.OK).json({ msg: `Attendance marked for ${results.length} students`, count: results.length });
};

/**
 * Get monthly attendance calendar data for a class
 * Returns an object: { "2026-03-01": { rate: 0.95, present: 38, total: 40 }, ... }
 */
const getAttendanceCalendar = async (req, res) => {
    const { classId, month, year } = req.query;
    if (!classId) throw new CustomError.BadRequestError('classId is required');

    const m = month || (new Date().getMonth() + 1).toString().padStart(2, '0');
    const y = year || new Date().getFullYear().toString();
    const prefix = `${y}-${m}`;

    const records = await prisma.attendanceRecord.findMany({
        where: { classId, date: { startsWith: prefix }, student: { schoolId: req.user.schoolId } },
    });

    const totalStudents = await prisma.studentProfile.count({ where: { classId, status: 'Active', schoolId: req.user.schoolId } });

    // Group by date
    const byDate = {};
    for (const r of records) {
        if (!byDate[r.date]) byDate[r.date] = { present: 0, absent: 0, late: 0, excused: 0 };
        if (r.status === 'PRESENT') byDate[r.date].present++;
        else if (r.status === 'ABSENT') byDate[r.date].absent++;
        else if (r.status === 'LATE') byDate[r.date].late++;
        else if (r.status === 'EXCUSED') byDate[r.date].excused++;
    }

    const calendar = Object.fromEntries(
        Object.entries(byDate).map(([date, counts]) => [
            date, { ...counts, total: totalStudents, rate: Number(((counts.present + counts.late) / (totalStudents || 1)).toFixed(2)) }
        ])
    );

    res.status(StatusCodes.OK).json({ calendar, totalStudents });
};

/**
 * Get student attendance history matrix
 */
const getStudentHistory = async (req, res) => {
    const { classId, month, year } = req.query;
    if (!classId) throw new CustomError.BadRequestError('classId is required');

    const m = month || (new Date().getMonth() + 1).toString().padStart(2, '0');
    const y = year || new Date().getFullYear().toString();
    const prefix = `${y}-${m}`;

    const students = await prisma.studentProfile.findMany({
        where: { classId, status: 'Active', schoolId: req.user.schoolId },
        include: { user: { select: { name: true } }, attendanceRecords: { where: { date: { startsWith: prefix } } } },
        orderBy: { admissionNo: 'asc' },
    });

    const data = students.map(s => ({
        studentId: s.id,
        name: s.user.name,
        admissionNo: s.admissionNo,
        present: s.attendanceRecords.filter(r => r.status === 'PRESENT').length,
        absent: s.attendanceRecords.filter(r => r.status === 'ABSENT').length,
        late: s.attendanceRecords.filter(r => r.status === 'LATE').length,
        excused: s.attendanceRecords.filter(r => r.status === 'EXCUSED').length,
        records: Object.fromEntries(s.attendanceRecords.map(r => [r.date, r.status])),
    }));

    res.status(StatusCodes.OK).json({ data });
};

/**
 * Get personal attendance history for Student/Parent
 */
const getMyAttendance = async (req, res) => {
    const { month, year, studentProfileId } = req.query;

    let targetStudentId = studentProfileId;

    if (req.user.role === 'STUDENT') {
        const student = await prisma.studentProfile.findUnique({
            where: { userId: req.user.id }
        });
        if (!student) throw new CustomError.NotFoundError('Student profile not found');
        targetStudentId = student.id;
    } else if (req.user.role === 'PARENT') {
        if (!targetStudentId) throw new CustomError.BadRequestError('studentProfileId query parameter is required for parents');
        const parent = await prisma.parentProfile.findUnique({
            where: { userId: req.user.id },
            include: { students: true }
        });
        if (!parent) throw new CustomError.NotFoundError('Parent profile not found');
        const isMyChild = parent.students.some(c => c.id === targetStudentId);
        if (!isMyChild) throw new CustomError.UnauthorizedError('Not authorized to view this student');
    } else {
        throw new CustomError.UnauthorizedError('Only Students and Parents can access this endpoint directly');
    }

    const m = month || (new Date().getMonth() + 1).toString().padStart(2, '0');
    const y = year || new Date().getFullYear().toString();
    const prefix = `${y}-${m}`;

    const records = await prisma.attendanceRecord.findMany({
        where: {
            studentProfileId: targetStudentId,
            date: { startsWith: prefix }
        },
        orderBy: { date: 'asc' }
    });

    const summary = {
        present: records.filter(r => r.status === 'PRESENT').length,
        absent: records.filter(r => r.status === 'ABSENT').length,
        late: records.filter(r => r.status === 'LATE').length,
        excused: records.filter(r => r.status === 'EXCUSED').length,
    };

    res.status(StatusCodes.OK).json({ records, summary });
};

/**
 * Get unique class levels from active students (for the class selector dropdown)
 */
/**
 * @deprecated Use GET /classes/all (Admin) or GET /teachers/me/classes (Teacher) instead.
 * Kept for backwards compatibility — returns an empty array now.
 */
const getClassLevels = async (req, res) => {
    res.status(StatusCodes.OK).json({ classLevels: [] });
};

// ─── TIMETABLE ─────────────────────────────────────────────────────────────────

/**
 * Get the full timetable for a class
 */
const getTimetable = async (req, res) => {
    const { classId } = req.query;
    if (!classId) throw new CustomError.BadRequestError('classId is required');

    const entries = await prisma.timetableEntry.findMany({ where: { classId, schoolId: req.user.schoolId } });
    res.status(StatusCodes.OK).json({ entries });
};

/**
 * Get all unique classIds that have timetable entries
 */
const getTimetableClasses = async (req, res) => {
    const grouped = await prisma.timetableEntry.groupBy({ by: ['classId'], where: { schoolId: req.user.schoolId } });
    const classIds = grouped.map(g => g.classId);
    res.status(StatusCodes.OK).json({ classIds });
};

/**
 * Save (upsert) a timetable slot
 * Body: { classId, day, period, subject, teacherName, teacherId, color }
 */
const upsertTimetableSlot = async (req, res) => {
    const { classId, day, period, subject, teacherName, teacherId, color } = req.body;
    if (!classId || !day || !period || !subject || !teacherName) {
        throw new CustomError.BadRequestError('classId, day, period, subject, and teacherName are required');
    }

    const entry = await prisma.timetableEntry.upsert({
        where: { classId_day_period: { classId, day, period } },
        create: { classId, day, period, subject, teacherName, teacherId, color: color || 'bg-blue-100 text-blue-700', schoolId: req.user.schoolId },
        update: { subject, teacherName, teacherId, color: color || 'bg-blue-100 text-blue-700' },
    });

    res.status(StatusCodes.OK).json({ msg: 'Slot saved', entry });
};

/**
 * Bulk save an entire class timetable (replaces existing, used by AI generation)
 * Body: { classId, slots: [{ day, period, subject, teacherName, teacherId, color }] }
 */
const saveTimetable = async (req, res) => {
    const { classId, slots } = req.body;
    if (!classId || !Array.isArray(slots)) {
        throw new CustomError.BadRequestError('classId and slots array are required');
    }

    // Delete existing for this class and re-insert
    await prisma.timetableEntry.updateMany({
        where: { classId },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    if (slots.length > 0) {
        await prisma.timetableEntry.createMany({
            data: slots.map(s => ({
                classId,
                day: s.day,
                period: s.period,
                subject: s.subject,
                teacherName: s.teacherName,
                teacherId: s.teacherId || null,
                color: s.color || 'bg-blue-100 text-blue-700',
                schoolId: req.user.schoolId
            })),
            skipDuplicates: true,
        });
    }

    res.status(StatusCodes.OK).json({ msg: `Timetable saved with ${slots.length} slots` });
};

/**
 * Delete a single timetable slot
 */
const deleteTimetableSlot = async (req, res) => {
    const { classId, day, period } = req.body;
    if (!classId || !day || !period) throw new CustomError.BadRequestError('classId, day, and period are required');

    await prisma.timetableEntry.updateMany({
        where: { classId, day, period },
        data: { isDeleted: true, deletedAt: new Date() }
    });
    res.status(StatusCodes.OK).json({ msg: 'Slot deleted' });
};

/**
 * Get available teachers from the DB (for slot modal dropdown)
 */
const getAvailableTeachers = async (req, res) => {
    const teachers = await prisma.teacherProfile.findMany({
        where: { status: 'Active', schoolId: req.user.schoolId },
        include: { user: { select: { name: true } } },
        orderBy: { employeeId: 'asc' },
    });
    res.status(StatusCodes.OK).json({
        teachers: teachers.map(t => ({ id: t.id, name: t.user.name, department: t.department }))
    });
};

/**
 * Get available subjects from DB
 */
const getAvailableSubjects = async (req, res) => {
    const subjects = await prisma.subject.findMany({ where: { status: 'Active', schoolId: req.user.schoolId }, orderBy: { name: 'asc' } });
    res.status(StatusCodes.OK).json({ subjects: subjects.map(s => s.name) });
};

/**
 * Get the setup configuration for a particular class's timetable.
 */
const getTimetableSetup = async (req, res) => {
    const { classId } = req.query;
    if (!classId) throw new CustomError.BadRequestError('classId is required');

    let setup = await prisma.timetableSetup.findUnique({
        where: { classId }
    });

    if (!setup) {
        // Return default values if not explicitly set yet
        setup = {
            classId,
            numOfPeriods: 8,
            periodDuration: 45,
            startTime: "08:00 AM",
            shortBreakStart: "10:15 AM",
            shortBreakEnd: "10:30 AM",
            longBreakStart: "12:00 PM",
            longBreakEnd: "12:30 PM",
        }
    }

    res.status(StatusCodes.OK).json({ setup });
};

/**
 * Update the timetable setup for a specific class (or all classes if requested).
 */
const updateTimetableSetup = async (req, res) => {
    const { classId, setupData, applyToAll } = req.body;

    if (!setupData) throw new CustomError.BadRequestError('setupData is required');

    if (applyToAll) {
        // Find all active class levels from student profile
        const activeLevels = await prisma.studentProfile.groupBy({
            by: ['classLevel'],
            where: { status: 'Active', schoolId: req.user.schoolId },
        });

        // Also include any hardcoded classes currently in TimetableEntry just in case
        const groupedEntries = await prisma.timetableEntry.groupBy({ by: ['classId'], where: { schoolId: req.user.schoolId } });
        const allClasses = Array.from(new Set([
            ...activeLevels.map(l => l.classLevel),
            ...groupedEntries.map(g => g.classId),
            classId // Ensures the current one is handled if DB is entirely empty
        ])).filter(Boolean);

        const upserts = allClasses.map(cId =>
            prisma.timetableSetup.upsert({
                where: { classId: cId },
                update: { ...setupData },
                create: { classId: cId, ...setupData }
            })
        );

        await prisma.$transaction(upserts);
        res.status(StatusCodes.OK).json({ msg: `Timetable setup applied to all ${allClasses.length} classes` });
    } else {
        if (!classId) throw new CustomError.BadRequestError('classId is required');

        const setup = await prisma.timetableSetup.upsert({
            where: { classId },
            update: { ...setupData },
            create: { classId, ...setupData }
        });
        res.status(StatusCodes.OK).json({ msg: 'Timetable setup updated', setup });
    }
};

module.exports = {
    // Attendance
    getAttendanceStats,
    getAttendanceRoster,
    markAttendance,
    getAttendanceCalendar,
    getStudentHistory,
    getClassLevels,
    // Timetable
    getTimetable,
    getTimetableSetup,
    updateTimetableSetup,
    getTimetableClasses,
    upsertTimetableSlot,
    saveTimetable,
    deleteTimetableSlot,
    getAvailableTeachers,
    getAvailableSubjects,
    getMyAttendance,
};
