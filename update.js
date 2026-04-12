const fs = require('fs');

const file = 'controllers/attendance.controller.js';
let content = fs.readFileSync(file, 'utf8');

const anchor = '// ─── QR MANAGEMENT ────────────────────────────────────────────────────────────';
const index = content.indexOf(anchor);

if (index === -1) {
    console.error('Anchor not found!');
    process.exit(1);
}

const topHalf = content.substring(0, index);

const bottomHalf = `// ─── QR MANAGEMENT ────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Global cache for attendance settings
const settingsCache = new Map();

const getCachedSettings = async (schoolId) => {
    if (settingsCache.has(schoolId)) return settingsCache.get(schoolId);
    const settings = await prisma.attendanceSettings.upsert({
        where: { schoolId }, update: {}, create: { schoolId }
    });
    settingsCache.set(schoolId, settings);
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

const getQRCodes = async (req, res) => {
    const { userType } = req.query;
    const where = { schoolId: req.user.schoolId };
    if (userType) where.userType = userType;
    if (req.user.branchId) where.branchId = req.user.branchId;

    const qrCodes = await prisma.qRCode.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.status(StatusCodes.OK).json({ qrCodes });
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
    if (!user) throw new CustomError.NotFoundError(\`\${payload.userType} not found\`);

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
                        data: { qrCodeId: qrRecord.id } // just update the QR used
                    });
                } else {
                    await tx.attendanceRecord.create({
                        data: {
                            schoolId: req.user.schoolId,
                            studentProfileId: user.id,
                            date: todayDate,
                            classId: user.classId,
                            status: computedStatus,
                            markedBy: 'QR Scanner',
                            qrCodeId: qrRecord.id
                        }
                    });
                }
            });

            await logScan(req.user.schoolId, qrRecord.id, user.id, 'student', deviceInfo, 'SUCCESS', \`Marked \${computedStatus}\`);
            return res.status(StatusCodes.OK).json({ msg: \`Student marked \${computedStatus}\`, userType: 'student' });
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
    
    // Invalidate cache
    settingsCache.delete(req.user.schoolId);

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

    generateQR, getQRCodes, deactivateQR, regenerateQR, registerScanner, scanQR,
    getStaffAttendance, markStaffManual, getStaffAttendanceStats,
    getAttendanceSettings, updateAttendanceSettings, getStudentReport, getStaffReport,
};
`;

fs.writeFileSync(file, topHalf + bottomHalf);
console.log('Successfully updated attendance.controller.js');
