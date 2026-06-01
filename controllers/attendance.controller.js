const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const jwt = require('jsonwebtoken');
const { getCache, setCache, invalidateCache } = require('../services/redis.service');

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
        orderBy: { user: { name: 'asc' } },
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
        orderBy: { user: { name: 'asc' } },
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

// ─── QR MANAGEMENT ────────────────────────────────────────────────────────────

const crypto = require('crypto');

const getCachedSettings = async (schoolId) => {
    const key = `attendance:settings:${schoolId}`;
    
    // Fallback included natively in getCache wrapper
    const cached = await getCache(key);
    if (cached) return cached;

    const settings = await prisma.attendanceSettings.upsert({
        where: { schoolId }, update: {}, create: { schoolId }
    });
    
    // Store with 300 seconds TTL
    await setCache(key, settings, 300);
    return settings;
};

const generateQR = async (req, res) => {
    const { userType, userId } = req.body;
    if (!userType || !userId) throw new CustomError.BadRequestError('userType and userId are required');
    if (!process.env.QR_SECRET) throw new CustomError.InternalServerError('QR_SECRET is missing from configuration');

    const payload = { userId, userType, schoolId: req.user.schoolId, branchId: req.user.branchId || null };
    const qrToken = jwt.sign(payload, process.env.QR_SECRET, { expiresIn: '1y' });

    const qrCode = await prisma.qRCode.create({
        data: { schoolId: req.user.schoolId, branchId: req.user.branchId || null, userType, userId, qrToken }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'QR Code generated securely', qrCode });
};

const generateBulkQR = async (req, res) => {
    const { userType } = req.body;
    if (!userType || !['student', 'staff'].includes(userType)) throw new CustomError.BadRequestError('Valid userType is required');
    if (!process.env.QR_SECRET) throw new CustomError.InternalServerError('QR_SECRET is missing from configuration');

    const schoolId = req.user.schoolId;
    let users = [];

    if (userType === 'student') {
        const existingQrs = await prisma.qRCode.findMany({ where: { schoolId, userType: 'student', isActive: true }, select: { userId: true } });
        const existingIds = existingQrs.map(q => q.userId);
        users = await prisma.studentProfile.findMany({ 
            where: { schoolId, status: 'Active', id: { notIn: existingIds } }
        });
    } else {
        const existingQrs = await prisma.qRCode.findMany({ where: { schoolId, userType: 'staff', isActive: true }, select: { userId: true } });
        const existingIds = existingQrs.map(q => q.userId);
        users = await prisma.teacherProfile.findMany({ 
            where: { schoolId, status: 'Active', id: { notIn: existingIds } }
        });
    }

    if (users.length === 0) {
        return res.status(StatusCodes.OK).json({ msg: `All ${userType}s already have active bindings.`, count: 0 });
    }

    const newQRs = users.map(u => {
        const payload = { userId: u.id, userType, schoolId, branchId: u.branchId || req.user.branchId || null };
        const qrToken = jwt.sign(payload, process.env.QR_SECRET, { expiresIn: '1y' });
        return {
            schoolId,
            branchId: u.branchId || req.user.branchId || null,
            userType,
            userId: u.id,
            qrToken
        };
    });

    await prisma.qRCode.createMany({ data: newQRs });

    res.status(StatusCodes.CREATED).json({ msg: `Successfully spun ${newQRs.length} new tokens.`, count: newQRs.length });
};

const getQRCodes = async (req, res) => {
    const { userType } = req.query;
    const schoolId = req.user.schoolId;
    const where = { schoolId };
    if (userType) where.userType = userType;
    if (req.user.branchId) where.branchId = req.user.branchId;

    // Get existing QR codes
    const qrCodes = await prisma.qRCode.findMany({ where, orderBy: { createdAt: 'desc' } });

    // Get the set of userIds that already have an ACTIVE QR
    const activeUserIds = new Set(qrCodes.filter(q => q.isActive).map(q => q.userId));

    // Fetch all users in this school/branch who DON'T have an active QR
    let usersWithout = [];
    const userWhere = { schoolId, isDeleted: false };
    if (req.user.branchId) userWhere.branchId = req.user.branchId;

    if (!userType || userType === 'student') {
        const students = await prisma.studentProfile.findMany({
            where: { ...userWhere, status: 'Active' },
            select: { id: true, admissionNo: true, user: { select: { name: true } } }
        });
        students
            .filter(s => !activeUserIds.has(s.id))
            .forEach(s => usersWithout.push({
                userId: s.id,
                userName: s.user?.name || s.admissionNo,
                userType: 'student',
                hasQR: false
            }));
    }

    if (!userType || userType === 'staff') {
        const staff = await prisma.teacherProfile.findMany({
            where: { ...userWhere, status: 'Active' },
            select: { id: true, employeeId: true, user: { select: { name: true } } }
        });
        staff
            .filter(s => !activeUserIds.has(s.id))
            .forEach(s => usersWithout.push({
                userId: s.id,
                userName: s.user?.name || s.employeeId,
                userType: 'staff',
                hasQR: false
            }));
    }

    res.status(StatusCodes.OK).json({ qrCodes, usersWithout });
};


const deactivateQR = async (req, res) => {
    const { id } = req.body;
    if (!id) throw new CustomError.BadRequestError('QR Code ID is required');

    await prisma.qRCode.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: { isActive: false }
    });
    res.status(StatusCodes.OK).json({ msg: 'QR Code deactivated' });
};

const regenerateQR = async (req, res) => {
    const { id } = req.body;
    if (!id) throw new CustomError.BadRequestError('QR Code ID is required');
    if (!process.env.QR_SECRET) throw new CustomError.InternalServerError('QR_SECRET is missing from configuration');

    const oldQr = await prisma.qRCode.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!oldQr) throw new CustomError.NotFoundError('QR Code not found');

    await prisma.qRCode.update({ where: { id: oldQr.id }, data: { isActive: false } });

    const payload = { userId: oldQr.userId, userType: oldQr.userType, schoolId: oldQr.schoolId, branchId: oldQr.branchId };
    const qrToken = jwt.sign(payload, process.env.QR_SECRET, { expiresIn: '1y' });

    const newQr = await prisma.qRCode.create({
        data: { schoolId: oldQr.schoolId, branchId: oldQr.branchId, userType: oldQr.userType, userId: oldQr.userId, qrToken }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'QR Code regenerated', qrCode: newQr });
};

// ─── SCANNER REGISTRATION & SECURE SCAN ───────────────────────────────────────

const registerScanner = async (req, res) => {
    const { deviceInfo } = req.body;
    const token = crypto.randomBytes(32).toString('hex');
    
    const scanner = await prisma.scannerDevice.create({
        data: {
            schoolId: req.user.schoolId,
            branchId: req.user.branchId || null,
            name: deviceInfo || 'Web Scanner',
            token
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Scanner registered successfully', token });
};

const scanQR = async (req, res) => {
    const { qrToken, scannerToken, deviceInfo } = req.body;
    if (!qrToken) throw new CustomError.BadRequestError('QR Token is required');
    if (!scannerToken) throw new CustomError.UnauthenticatedError('Scanner session token is missing');
    if (!process.env.QR_SECRET) throw new CustomError.InternalServerError('Server configuration error: missing QR_SECRET');

    // CONCURRENCY: Fetch Settings and Scanner concurrently
    const [settings, scanner] = await Promise.all([
        getCachedSettings(req.user.schoolId),
        prisma.scannerDevice.findUnique({ where: { token: scannerToken } })
    ]);

    if (!scanner || !scanner.isActive || scanner.schoolId !== req.user.schoolId) {
        throw new CustomError.UnauthenticatedError('Invalid or inactive scanner session');
    }

    let payload;
    try {
        payload = jwt.verify(qrToken, process.env.QR_SECRET);
    } catch (error) {
        throw new CustomError.UnauthenticatedError('Invalid or expired QR code');
    }

    // Branch Isolation & Verification
    if (payload.schoolId !== req.user.schoolId) throw new CustomError.UnauthorizedError('QR code belongs to a different school');
    if (payload.branchId && req.user.branchId && payload.branchId !== req.user.branchId) {
        throw new CustomError.UnauthorizedError('Unauthorized: Cross-branch scanning is restricted');
    }

    // TIMEZONE COMPLIANT DATE
    const nowTime = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayDate = formatter.format(nowTime); // YYYY-MM-DD in school's timezone

    // Optimize user and QR lookup 
    let userTask = payload.userType === 'student' 
        ? prisma.studentProfile.findUnique({ where: { id: payload.userId } })
        : prisma.teacherProfile.findUnique({ where: { id: payload.userId } });

    const [qrRecord, user] = await Promise.all([
        prisma.qRCode.findUnique({ where: { qrToken } }),
        userTask
    ]);

    if (!qrRecord || !qrRecord.isActive) throw new CustomError.BadRequestError('QR code is inactive or revoked');
    if (!user) throw new CustomError.NotFoundError(`${payload.userType} not found`);

    // Determine LATE logic using timezone offset properly
    const [th, tm] = settings.lateThresholdTime.split(':').map(Number);
    const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone, hour: 'numeric', minute: 'numeric', hour12: false });
    const localTimeParts = timeFormatter.formatToParts(nowTime);
    
    // Fallback logic incase Intl parts aren't reliable immediately
    const localHrStr = localTimeParts.find(p => p.type === 'hour')?.value || '0';
    const localMinStr = localTimeParts.find(p => p.type === 'minute')?.value || '0';
    
    const localHr = parseInt(localHrStr, 10) === 24 ? 0 : parseInt(localHrStr, 10);
    const localMin = parseInt(localMinStr, 10);
    
    const isLate = localHr > th || (localHr === th && localMin > tm);
    const computedStatus = isLate ? 'LATE' : 'PRESENT';

    if (payload.userType === 'student') {
        if (!user.classId) throw new CustomError.BadRequestError('Student has no assigned class; cannot mark attendance');

        try {
            await prisma.$transaction(async (tx) => {
                const existing = await tx.attendanceRecord.findUnique({
                    where: { studentProfileId_date: { studentProfileId: user.id, date: todayDate } }
                });

                if (existing) {
                    if (!settings.allowMultipleScan) {
                        throw new Error('DUPLICATE_STUDENT');
                    }
                    await tx.attendanceRecord.update({
                        where: { id: existing.id },
                        data: { status: computedStatus, markedBy: 'QR Scanner' }
                    });
                } else {
                    await tx.attendanceRecord.create({
                        data: {
                            schoolId: req.user.schoolId,
                            studentProfileId: user.id,
                            date: todayDate,
                            classId: user.classId,
                            status: computedStatus,
                            markedBy: 'QR Scanner'
                        }
                    });
                }
            });

            await logScan(req.user.schoolId, qrRecord.id, user.id, 'student', deviceInfo, 'SUCCESS', `Marked ${computedStatus}`);
            return res.status(StatusCodes.OK).json({ msg: `Student marked ${computedStatus}`, userType: 'student' });
        } catch (error) {
            if (error.message === 'DUPLICATE_STUDENT' || error.code === 'P2002') {
                await logScan(req.user.schoolId, qrRecord.id, user.id, 'student', deviceInfo, 'DUPLICATE', 'Already marked today');
                return res.status(StatusCodes.OK).json({ msg: 'Student attendance already recorded for today', duplicate: true });
            }
            throw error;
        }

    } else if (payload.userType === 'staff') {
        try {
            return await prisma.$transaction(async (tx) => {
                const existing = await tx.staffAttendance.findUnique({
                    where: { staffId_date: { staffId: user.id, date: todayDate } }
                });

                if (!existing) {
                    await tx.staffAttendance.create({
                        data: {
                            schoolId: req.user.schoolId,
                            branchId: user.branchId || null,
                            staffId: user.id,
                            date: todayDate,
                            checkInTime: nowTime,
                            status: computedStatus,
                            markedBy: 'QR' // ensure markedBy matches String logic
                        }
                    });
                    await logScan(req.user.schoolId, qrRecord.id, user.id, 'staff', deviceInfo, 'SUCCESS', 'Check-In');
                    return res.status(StatusCodes.OK).json({ msg: 'Staff Check-In successful', userType: 'staff', action: 'check-in' });
                } else if (!existing.checkOutTime) {
                    // COOLDOWN LOGIC: Prevent instant double-scans checking you out in under 5 minutes
                    const checkInLocal = existing.checkInTime ? new Date(existing.checkInTime).getTime() : 0;
                    const diffMins = (nowTime.getTime() - checkInLocal) / 60000;
                    if (diffMins < 5) {
                        await logScan(req.user.schoolId, qrRecord.id, user.id, 'staff', deviceInfo, 'DUPLICATE', 'Checkout ignored due to 5-minute cooldown rule');
                        throw new Error('STAFF_COOLDOWN');
                    }

                    await tx.staffAttendance.update({
                        where: { id: existing.id },
                        data: { checkOutTime: nowTime }
                    });
                    await logScan(req.user.schoolId, qrRecord.id, user.id, 'staff', deviceInfo, 'SUCCESS', 'Check-Out');
                    return res.status(StatusCodes.OK).json({ msg: 'Staff Check-Out successful', userType: 'staff', action: 'check-out' });
                } else {
                    await logScan(req.user.schoolId, qrRecord.id, user.id, 'staff', deviceInfo, 'DUPLICATE', 'Already checked out');
                    throw new Error('STAFF_DUPLICATE');
                }
            });
        } catch (error) {
            if (error.code === 'P2002' || error.message === 'STAFF_DUPLICATE') {
                return res.status(StatusCodes.OK).json({ msg: 'Already completed attendance for today', duplicate: true });
            }
            if (error.message === 'STAFF_COOLDOWN') {
                return res.status(StatusCodes.OK).json({ msg: 'Checkout ignored: Must wait at least 5 minutes after check-in', duplicate: true });
            }
            throw error;
        }
    }

    throw new CustomError.BadRequestError('Unknown user type');
};

const logScan = async (schoolId, qrCodeId, userId, userType, deviceInfo, result, reason) => {
    return prisma.attendanceScanLog.create({
        data: { schoolId, qrCodeId, userId, userType, deviceInfo, result, reason }
    });
};

// ─── STAFF ATTENDANCE ─────────────────────────────────────────────────────────

const getStaffAttendance = async (req, res) => {
    const { date, branchId } = req.query;
    // Resolve date based on server fallback loosely if no date provided
    const targetDate = date || new Date().toISOString().split('T')[0];

    const where = { schoolId: req.user.schoolId, date: targetDate };
    
    // strict branch check
    if (req.user.branchId) {
        where.branchId = req.user.branchId;
    } else if (branchId) {
        where.branchId = branchId;
    }

    const records = await prisma.staffAttendance.findMany({
        where,
        include: { staff: { include: { user: { select: { name: true } } } } }
    });

    res.status(StatusCodes.OK).json({ records });
};

const markStaffManual = async (req, res) => {
    const { staffId, date, status, note, checkInTime, checkOutTime } = req.body;
    if (!staffId || !date || !status) throw new CustomError.BadRequestError('staffId, date, and status are required');

    const staff = await prisma.teacherProfile.findUnique({ where: { id: staffId } });
    if (!staff) throw new CustomError.NotFoundError('Staff not found');
    
    if (req.user.branchId && staff.branchId !== req.user.branchId) {
        throw new CustomError.UnauthorizedError('Cannot manually mark staff across branches');
    }

    const record = await prisma.staffAttendance.upsert({
        where: { staffId_date: { staffId, date } },
        create: {
            schoolId: req.user.schoolId, branchId: staff.branchId || null, staffId, date, status, note,
            checkInTime: checkInTime ? new Date(checkInTime) : null,
            checkOutTime: checkOutTime ? new Date(checkOutTime) : null,
            markedBy: 'MANUAL'
        },
        update: {
            status, note,
            checkInTime: checkInTime ? new Date(checkInTime) : undefined,
            checkOutTime: checkOutTime ? new Date(checkOutTime) : undefined,
            markedBy: 'MANUAL'
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Staff attendance manually updated', record });
};

const getStaffAttendanceStats = async (req, res) => {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const where = { schoolId: req.user.schoolId, date: targetDate };
    const staffWhere = { schoolId: req.user.schoolId, status: 'Active' };

    if (req.user.branchId) {
        where.branchId = req.user.branchId;
        staffWhere.branchId = req.user.branchId;
    }

    const [present, late, halfDay, absent, total] = await Promise.all([
        prisma.staffAttendance.count({ where: { ...where, status: 'PRESENT' } }),
        prisma.staffAttendance.count({ where: { ...where, status: 'LATE' } }),
        prisma.staffAttendance.count({ where: { ...where, status: 'HALF_DAY' } }),
        prisma.staffAttendance.count({ where: { ...where, status: 'ABSENT' } }),
        prisma.teacherProfile.count({ where: staffWhere })
    ]);

    res.status(StatusCodes.OK).json({
        date: targetDate, totalStaff: total,
        present, late, halfDay, absent
    });
};

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

const getAttendanceSettings = async (req, res) => {
    const settings = await getCachedSettings(req.user.schoolId);
    res.status(StatusCodes.OK).json({ settings });
};

const updateAttendanceSettings = async (req, res) => {
    const { schoolStartTime, lateThresholdTime, allowMultipleScan, qrEnabled, manualEnabled, autoCloseTime, staffCheckOutRequired, timezone } = req.body;

    const settings = await prisma.attendanceSettings.upsert({
        where: { schoolId: req.user.schoolId },
        update: { schoolStartTime, lateThresholdTime, allowMultipleScan, qrEnabled, manualEnabled, autoCloseTime, staffCheckOutRequired, timezone },
        create: { schoolId: req.user.schoolId, schoolStartTime, lateThresholdTime, allowMultipleScan, qrEnabled, manualEnabled, autoCloseTime, staffCheckOutRequired, timezone }
    });
    
    // Invalidate cache securely
    await invalidateCache(`attendance:settings:${req.user.schoolId}`);

    res.status(StatusCodes.OK).json({ msg: 'Settings updated', settings });
};

// ─── REPORTS ──────────────────────────────────────────────────────────────────

const getStudentReport = async (req, res) => {
    const { startDate, endDate, classId } = req.query;
    res.status(StatusCodes.OK).json({ msg: 'Student report endpoint active', filters: { startDate, endDate, classId } });
};

const getStaffReport = async (req, res) => {
    const { startDate, endDate } = req.query;
    res.status(StatusCodes.OK).json({ msg: 'Staff report endpoint active', filters: { startDate, endDate } });
};

module.exports = {
    getAttendanceStats, getAttendanceRoster, markAttendance, getAttendanceCalendar,
    getStudentHistory, getClassLevels, getTimetable, getTimetableSetup, updateTimetableSetup,
    getTimetableClasses, upsertTimetableSlot, saveTimetable, deleteTimetableSlot,
    getAvailableTeachers, getAvailableSubjects, getMyAttendance,

    generateQR, generateBulkQR, getQRCodes, deactivateQR, regenerateQR, registerScanner, scanQR,
    getStaffAttendance, markStaffManual, getStaffAttendanceStats,
    getAttendanceSettings, updateAttendanceSettings, getStudentReport, getStaffReport,
};
