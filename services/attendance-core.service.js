const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');
const { deliver, schoolNow } = require('./timetable-alerts.service');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CH = { notification: true, email: false, whatsapp: false };

const DEFAULT_ALERTS = {
    staffReminders: { enabled: true, beforeResume: [15], beforeLate: [5], beforeSignOut: [10], afterClosing: [30], channels: { ...CH } },
    parentAlerts: { enabled: true, onSignIn: true, onSignOut: true, onLate: true, onAbsent: true, channels: { ...CH } },
    adminAlerts: { staffEvents: true, studentEvents: false, exceptions: true, channels: { ...CH } },
    allowUserPreferences: true,
};
const DEFAULT_DEDUCTION = { lateMode: 'NONE', lateAmount: 0, lateFreePerMonth: 0, absentMode: 'NONE', absentAmount: 0, halfDayAsHalfAbsent: true, maxPercentOfGross: 50 };

const mergeAlerts = (s) => ({
    staffReminders: { ...DEFAULT_ALERTS.staffReminders, ...s?.staffReminders, channels: { ...CH, ...s?.staffReminders?.channels } },
    parentAlerts: { ...DEFAULT_ALERTS.parentAlerts, ...s?.parentAlerts, channels: { ...CH, ...s?.parentAlerts?.channels } },
    adminAlerts: { ...DEFAULT_ALERTS.adminAlerts, ...s?.adminAlerts, channels: { ...CH, ...s?.adminAlerts?.channels } },
    allowUserPreferences: s?.allowUserPreferences ?? true,
});
const mergeDeduction = (d) => ({ ...DEFAULT_DEDUCTION, ...(d || {}) });

const getSettings = async (schoolId) => {
    const row = await prisma.attendanceSettings.upsert({ where: { schoolId }, update: {}, create: { schoolId } });
    return { ...row, alerts: mergeAlerts(row.alertConfig), deduction: mergeDeduction(row.deductionPolicy) };
};

// ─── time helpers (all in the school's timezone) ─────────────────────────────
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtMin = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const isHoliday = (settings, dateStr) => (settings.holidays || []).includes(dateStr);
const weekdayOf = (dateStr) => WEEKDAYS[(new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7];

/** Effective working schedule for a staff member: personal arrangement when set, else the school's. */
const scheduleFor = (settings, policy) => {
    const own = policy && !policy.useSchoolSchedule;
    return {
        resume: toMin(own && policy.resumeTime ? policy.resumeTime : settings.staffResumeTime),
        lateAfter: toMin(own && policy.lateAfterTime ? policy.lateAfterTime : settings.staffLateAfterTime),
        closing: toMin(own && policy.closingTime ? policy.closingTime : settings.staffClosingTime),
        workDays: own && policy.workDays?.length ? policy.workDays : settings.workDays,
    };
};
const isWorkday = (settings, policy, dateStr) => !isHoliday(settings, dateStr) && scheduleFor(settings, policy).workDays.includes(weekdayOf(dateStr));

// ─── geofence ────────────────────────────────────────────────────────────────
const distanceMeters = (la1, lo1, la2, lo2) => {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
};

class AttendanceError extends Error { constructor(message, status = 400, code = 'REJECTED') { super(message); this.statusCode = status; this.code = code; } }

/** Throws unless the device is inside the school's radius (when the school requires it). Returns { distance } or null. */
const checkLocation = (settings, loc) => {
    if (!settings.requireLocationForSelfScan) return null;
    if (settings.schoolLat == null || settings.schoolLng == null) throw new AttendanceError('The school location has not been set yet. Ask the administrator to set it in Attendance settings.', 409, 'NO_SCHOOL_LOCATION');
    const lat = Number(loc?.lat), lng = Number(loc?.lng), acc = Number(loc?.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new AttendanceError('Your location is required. Allow location access in your browser and try again.', 400, 'NO_LOCATION');
    if (loc.at && Date.now() - Number(loc.at) > 2 * 60 * 1000) throw new AttendanceError('Your location reading is out of date. Refresh it and try again.', 400, 'STALE_LOCATION');
    if (Number.isFinite(acc) && acc > settings.maxGpsAccuracyMeters) throw new AttendanceError(`Your GPS signal is too weak (±${Math.round(acc)} m). Move outdoors or turn on high-accuracy location and try again.`, 400, 'LOW_ACCURACY');
    const distance = distanceMeters(lat, lng, settings.schoolLat, settings.schoolLng);
    if (distance > settings.geoRadiusMeters) throw Object.assign(new AttendanceError(`You are about ${distance} m from the school. You must be within ${settings.geoRadiusMeters} m to sign in or out.`, 403, 'OUTSIDE_SCHOOL'), { distance });
    return { distance };
};

// ─── wall QR ────────────────────────────────────────────────────────────────
const qrSecret = () => process.env.QR_SECRET || process.env.JWT_SECRET;

/** Bumps the version when auto-rotation is due. Returns the (possibly refreshed) settings row. */
const rotateIfDue = async (settings) => {
    const days = settings.wallQrAutoRotateDays;
    if (days > 0 && Date.now() - new Date(settings.wallQrRotatedAt).getTime() > days * 86400000) {
        const row = await prisma.attendanceSettings.update({ where: { schoolId: settings.schoolId }, data: { wallQrVersion: { increment: 1 }, wallQrRotatedAt: new Date() } });
        return { ...settings, ...row };
    }
    return settings;
};
const wallToken = (settings) => jwt.sign({ purpose: 'WALL', schoolId: settings.schoolId, v: settings.wallQrVersion }, qrSecret());
const verifyWallToken = (token, settings) => {
    let p;
    try { p = jwt.verify(String(token || ''), qrSecret()); } catch { throw new AttendanceError('This QR code is not valid.', 400, 'BAD_QR'); }
    if (p.purpose !== 'WALL' || p.schoolId !== settings.schoolId) throw new AttendanceError('This QR code belongs to a different school.', 403, 'BAD_QR');
    if (p.v !== settings.wallQrVersion) throw new AttendanceError('This QR code has been replaced. Scan the new one on the school wall.', 400, 'OLD_QR');
};

// ─── events & alerts ─────────────────────────────────────────────────────────
const logEvent = (e) => prisma.attendanceEvent.create({ data: { ...e, userName: e.userName || 'Unknown' } }).catch((err) => console.error('[attendance] event log failed:', err.message));

const claim = async (key) => (await prisma.timetableAlertLog.createMany({ data: [{ key }], skipDuplicates: true })).count === 1;

const getPrefs = async (userId) => (await prisma.attendancePreference.findUnique({ where: { userId } }))?.config || null;

const phoneOf = async (schoolId, userId) => {
    const [t, p] = await Promise.all([
        prisma.teacherProfile.findFirst({ where: { userId, schoolId }, select: { phone: true } }),
        prisma.parentProfile.findFirst({ where: { userId, schoolId }, select: { phone: true } }),
    ]);
    return t?.phone || p?.phone || null;
};

/** Sends to one user over the school's channels, narrowed by that user's own choices when the school allows it. */
const notifyUser = async ({ schoolId, user, channels, prefs, allowPrefs, title, message, link }) => {
    let ch = { ...channels };
    if (allowPrefs && prefs?.channels) ch = { notification: !!prefs.channels.notification, email: !!prefs.channels.email, whatsapp: !!prefs.channels.whatsapp };
    return deliver({ schoolId, user, phone: await phoneOf(schoolId, user.id), channels: ch, title, message, link, type: 'ATTENDANCE' });
};

const adminUsers = (schoolId) => prisma.user.findMany({ where: { schoolId, role: { in: ADMIN_ROLES }, isDeleted: false }, select: { id: true, email: true, name: true } });

/** Tell the school's administrators about an event (live feed alert, per the school's alert settings). */
const alertAdmins = async (settings, { title, message, exception = false, userType }) => {
    const a = settings.alerts.adminAlerts;
    const on = exception ? a.exceptions : userType === 'staff' ? a.staffEvents : a.studentEvents;
    if (!on) return;
    for (const u of await adminUsers(settings.schoolId)) {
        await notifyUser({ schoolId: settings.schoolId, user: u, channels: a.channels, title, message, link: '/dashboard/attendance' }).catch(() => {});
    }
};

const hhmm = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

/** Alert a student's parent when the child signs in / out / is marked late or absent today. */
const alertParent = async (settings, student, kind, at) => {
    const cfg = settings.alerts.parentAlerts;
    if (!cfg.enabled || !{ IN: cfg.onSignIn, OUT: cfg.onSignOut, LATE: cfg.onLate, ABSENT: cfg.onAbsent }[kind]) return;
    const full = student.parent ? student : await prisma.studentProfile.findUnique({ where: { id: student.id }, include: { user: { select: { name: true } }, parent: { include: { user: { select: { id: true, email: true, name: true } } } } } });
    const parent = full?.parent;
    if (!parent) return;
    const key = `ATTP|${full.id}|${schoolNow(settings.timezone, at).dateStr}|${kind}`;
    if (!(await claim(key))) return;
    const prefs = await getPrefs(parent.userId);
    if (prefs && prefs.childAlerts === false) return;
    if (prefs && prefs.events && prefs.events[kind] === false) return;
    const name = full.user?.name || 'Your child', time = hhmm(at, settings.timezone);
    const text = {
        IN: `${name} arrived at school at ${time}.`, LATE: `${name} arrived late at school at ${time}.`,
        OUT: `${name} left school at ${time}.`, ABSENT: `${name} has been marked absent today.`,
    }[kind];
    await notifyUser({ schoolId: settings.schoolId, user: parent.user, channels: cfg.channels, prefs, allowPrefs: settings.alerts.allowUserPreferences, title: kind === 'OUT' ? 'Child left school' : kind === 'ABSENT' ? 'Absence notice' : 'Child in school', message: text, link: '/parent/attendance' });
};

// ─── staff sign-in / sign-out ────────────────────────────────────────────────
/**
 * Signs a staff member in or out (whichever comes next). Used by card scans, the wall QR and the admin register.
 * `staff` = TeacherProfile (with user). Throws AttendanceError for expected rejections.
 */
const staffSign = async ({ settings, staff, method, loc, deviceInfo, actor, now = new Date() }) => {
    const sn = schoolNow(settings.timezone, now);
    const policy = await prisma.staffAttendancePolicy.findUnique({ where: { staffId: staff.id } });
    const sched = scheduleFor(settings, policy);
    const name = staff.user?.name || staff.employeeId;
    const base = { schoolId: settings.schoolId, userType: 'staff', userId: staff.id, userName: name, method, deviceInfo: deviceInfo || null, actorUserId: actor?.userId || null, actorName: actor?.name || null };

    let where = null;
    if (method === 'WALL_QR') {
        try { where = checkLocation(settings, loc); }
        catch (e) {
            await logEvent({ ...base, action: 'REJECTED', note: e.message, lat: Number(loc?.lat) || null, lng: Number(loc?.lng) || null, distanceMeters: e.distance ?? null });
            if (e.code === 'OUTSIDE_SCHOOL' && await claim(`ATTX|${staff.id}|${sn.dateStr}|geo`)) await alertAdmins(settings, { title: 'Sign-in attempt outside school', message: `${name} tried to sign in ${e.distance} m from the school and was refused.`, exception: true });
            throw e;
        }
    }
    const geo = { lat: loc?.lat != null ? Number(loc.lat) : null, lng: loc?.lng != null ? Number(loc.lng) : null };
    const existing = await prisma.staffAttendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: sn.dateStr } } });
    const signedIn = !!existing?.checkInTime;

    if (!signedIn) {
        if (sn.minutes < toMin(settings.staffSignInOpensTime)) throw new AttendanceError(`Sign-in opens at ${settings.staffSignInOpensTime}.`, 400, 'TOO_EARLY');
        const working = isWorkday(settings, policy, sn.dateStr);
        const late = working && !policy?.exempt && sn.minutes > sched.lateAfter;
        const lateMinutes = late ? sn.minutes - sched.resume : 0;
        const status = late ? 'LATE' : 'PRESENT';
        const data = { checkInTime: now, status, markedBy: method === 'CARD_SCAN' ? 'QR' : method, signInMethod: method, lateMinutes, inLat: geo.lat, inLng: geo.lng };
        const rec = existing
            ? await prisma.staffAttendance.update({ where: { id: existing.id }, data })
            : await prisma.staffAttendance.create({ data: { schoolId: settings.schoolId, staffId: staff.id, date: sn.dateStr, ...data } });
        await logEvent({ ...base, action: 'SIGN_IN', status, lateMinutes, lat: geo.lat, lng: geo.lng, distanceMeters: where?.distance ?? null, occurredAt: now });
        await alertAdmins(settings, { title: late ? 'Staff signed in late' : 'Staff signed in', message: `${name} signed in at ${hhmm(now, settings.timezone)}${late ? ` (${lateMinutes} min late)` : ''}.`, userType: 'staff' });
        return { action: 'SIGN_IN', status, lateMinutes, time: now, record: rec, message: late ? `Signed in at ${hhmm(now, settings.timezone)} — ${lateMinutes} minutes late.` : `Signed in at ${hhmm(now, settings.timezone)}. Have a great day!` };
    }
    if (existing.checkOutTime) throw new AttendanceError('You have already signed out today.', 409, 'DONE');
    const since = (now.getTime() - existing.checkInTime.getTime()) / 60000;
    if (since < settings.minSessionMinutes) throw new AttendanceError(`You signed in ${Math.max(1, Math.round(since))} minute(s) ago. Wait at least ${settings.minSessionMinutes} minutes before signing out.`, 409, 'TOO_SOON');
    const early = Math.max(0, sched.closing - sn.minutes);
    const rec = await prisma.staffAttendance.update({ where: { id: existing.id }, data: { checkOutTime: now, signOutMethod: method, earlyLeaveMinutes: early, outLat: geo.lat, outLng: geo.lng } });
    await logEvent({ ...base, action: 'SIGN_OUT', status: existing.status, lat: geo.lat, lng: geo.lng, distanceMeters: where?.distance ?? null, note: early ? `${early} min before closing` : null, occurredAt: now });
    await alertAdmins(settings, { title: 'Staff signed out', message: `${name} signed out at ${hhmm(now, settings.timezone)}${early ? ` (${early} min before closing)` : ''}.`, userType: 'staff' });
    return { action: 'SIGN_OUT', status: existing.status, earlyLeaveMinutes: early, time: now, record: rec, message: `Signed out at ${hhmm(now, settings.timezone)}.${early ? ` That is ${early} minutes before closing time.` : ''}` };
};

// ─── student sign-in / sign-out ──────────────────────────────────────────────
const studentSign = async ({ settings, student, method, deviceInfo, actor, now = new Date() }) => {
    const sn = schoolNow(settings.timezone, now);
    if (!student.classId) throw new AttendanceError('Student has no assigned class; cannot mark attendance');
    const name = student.user?.name || student.admissionNo;
    const base = { schoolId: settings.schoolId, userType: 'student', userId: student.id, userName: name, classId: student.classId, method, deviceInfo: deviceInfo || null, actorUserId: actor?.userId || null, actorName: actor?.name || null };
    const existing = await prisma.attendanceRecord.findUnique({ where: { studentProfileId_date: { studentProfileId: student.id, date: sn.dateStr } } });
    const signedIn = !!existing && !!existing.signInTime;

    if (!signedIn) {
        const late = sn.minutes > toMin(settings.lateThresholdTime);
        const status = late ? 'LATE' : 'PRESENT';
        const data = { status, signInTime: now, signInMethod: method, markedBy: actor?.name || 'Card Scanner' };
        const rec = existing
            ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data })
            : await prisma.attendanceRecord.create({ data: { schoolId: settings.schoolId, studentProfileId: student.id, date: sn.dateStr, classId: student.classId, ...data } });
        await logEvent({ ...base, action: 'SIGN_IN', status, occurredAt: now });
        await alertParent(settings, student, late ? 'LATE' : 'IN', now).catch((e) => console.error('[attendance] parent alert failed:', e.message));
        await alertAdmins(settings, { title: 'Student signed in', message: `${name} signed in at ${hhmm(now, settings.timezone)}${late ? ' (late)' : ''}.`, userType: 'student' });
        return { action: 'SIGN_IN', status, time: now, record: rec, message: `${name} signed in${late ? ' (late)' : ''}` };
    }
    if (!settings.studentSignOutEnabled) throw new AttendanceError('Attendance already recorded for today.', 409, 'DONE');
    if (existing.signOutTime) throw new AttendanceError('Already signed out today.', 409, 'DONE');
    const since = (now.getTime() - existing.signInTime.getTime()) / 60000;
    if (since < settings.minSessionMinutes) throw new AttendanceError('Just signed in. Please wait a few minutes before signing out.', 409, 'TOO_SOON');
    const rec = await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { signOutTime: now, signOutMethod: method } });
    await logEvent({ ...base, action: 'SIGN_OUT', status: existing.status, occurredAt: now });
    await alertParent(settings, student, 'OUT', now).catch((e) => console.error('[attendance] parent alert failed:', e.message));
    await alertAdmins(settings, { title: 'Student signed out', message: `${name} signed out at ${hhmm(now, settings.timezone)}.`, userType: 'student' });
    return { action: 'SIGN_OUT', status: existing.status, time: now, record: rec, message: `${name} signed out` };
};

module.exports = {
    ADMIN_ROLES, WEEKDAYS, DEFAULT_ALERTS, DEFAULT_DEDUCTION, mergeAlerts, mergeDeduction, getSettings, toMin, fmtMin, isHoliday, weekdayOf, scheduleFor, isWorkday,
    distanceMeters, AttendanceError, checkLocation, rotateIfDue, wallToken, verifyWallToken, logEvent, claim, getPrefs, notifyUser, alertAdmins, alertParent,
    staffSign, studentSign, schoolNow, hhmm,
};
