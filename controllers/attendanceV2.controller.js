const QRCode = require('qrcode');
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { invalidateCache } = require('../services/redis.service');
const core = require('../services/attendance-core.service');
const rep = require('../services/attendance-report.service');
const { computeStaffDeductions } = require('../services/attendance-payroll.service');
const { getBrowser, letterhead, esc } = require('../services/academic-export.service');

const { AttendanceError, ADMIN_ROLES } = core;
const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);
const pad = (n) => String(n).padStart(2, '0');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** Wraps controllers so expected attendance rejections come back as {msg, code} with the right status. */
const guard = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
        if (e instanceof AttendanceError) return res.status(e.statusCode).json({ msg: e.message, code: e.code, ...(e.distance != null && { distance: e.distance }) });
        next(e);
    }
};

const loadSchool = (schoolId) => prisma.schoolSettings.findFirst({ where: { schoolId }, select: { schoolName: true, arabicName: true, logoUrl: true, address: true } });
const myStaff = (req) => prisma.teacherProfile.findFirst({ where: { userId: req.user.userId, schoolId: req.user.schoolId, isDeleted: false }, include: { user: { select: { name: true, email: true } } } });

/** "08:30" on a calendar day in the school's timezone → the real instant. */
const zoned = (dateStr, hhmm, tz) => {
    const [h, m] = hhmm.split(':').map(Number);
    const guess = new Date(`${dateStr}T${pad(h)}:${pad(m)}:00Z`);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(guess).map(x => [x.type, x.value]));
    const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return new Date(guess.getTime() - (asLocal - guess.getTime()));
};
const localHHMM = (d, tz) => (d ? core.hhmm(d, tz) : '');

// ─── settings ────────────────────────────────────────────────────────────────
const publicSettings = (s) => {
    const { alertConfig, deductionPolicy, ...rest } = s;
    return rest;
};

const getSettings = async (req, res) => {
    const settings = await core.getSettings(req.user.schoolId);
    res.status(StatusCodes.OK).json({ settings: publicSettings(settings), weekdays: core.WEEKDAYS });
};

const updateSettings = async (req, res) => {
    const b = req.body || {};
    const cur = await core.getSettings(req.user.schoolId);
    const data = {};
    const time = (k) => { if (b[k] !== undefined) { if (!TIME_RE.test(b[k])) throw new CustomError.BadRequestError(`${k} must be a time like 08:00`); data[k] = b[k]; } };
    ['schoolStartTime', 'lateThresholdTime', 'staffResumeTime', 'staffLateAfterTime', 'staffClosingTime', 'staffSignInOpensTime', 'studentClosingTime'].forEach(time);
    if (b.autoCloseTime !== undefined) { if (b.autoCloseTime && !TIME_RE.test(b.autoCloseTime)) throw new CustomError.BadRequestError('autoCloseTime must be a time like 17:00'); data.autoCloseTime = b.autoCloseTime || null; }
    ['allowMultipleScan', 'qrEnabled', 'manualEnabled', 'staffCheckOutRequired', 'autoMarkStaffAbsent', 'studentSignOutEnabled', 'requireLocationForSelfScan', 'wallQrEnabled', 'autoDeductInPayroll']
        .forEach(k => { if (typeof b[k] === 'boolean') data[k] = b[k]; });
    if (b.timezone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); data.timezone = b.timezone; } catch { throw new CustomError.BadRequestError('Unknown timezone'); } }
    if (b.minSessionMinutes !== undefined) data.minSessionMinutes = Math.round(num(b.minSessionMinutes, 0, 240, 5));
    if (b.geoRadiusMeters !== undefined) data.geoRadiusMeters = Math.round(num(b.geoRadiusMeters, 20, 5000, 150));
    if (b.maxGpsAccuracyMeters !== undefined) data.maxGpsAccuracyMeters = Math.round(num(b.maxGpsAccuracyMeters, 10, 1000, 150));
    if (b.wallQrAutoRotateDays !== undefined) data.wallQrAutoRotateDays = Math.round(num(b.wallQrAutoRotateDays, 0, 365, 0));
    if (b.schoolLat !== undefined || b.schoolLng !== undefined) {
        const lat = b.schoolLat === null || b.schoolLat === '' ? null : Number(b.schoolLat), lng = b.schoolLng === null || b.schoolLng === '' ? null : Number(b.schoolLng);
        if ((lat === null) !== (lng === null)) throw new CustomError.BadRequestError('Give both latitude and longitude');
        if (lat !== null && (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180))) throw new CustomError.BadRequestError('Latitude must be between -90 and 90 and longitude between -180 and 180');
        data.schoolLat = lat; data.schoolLng = lng;
    }
    if (b.workDays !== undefined) {
        const w = (Array.isArray(b.workDays) ? b.workDays : []).filter(d => core.WEEKDAYS.includes(d));
        if (!w.length) throw new CustomError.BadRequestError('Choose at least one working day');
        data.workDays = w;
    }
    if (b.holidays !== undefined) data.holidays = [...new Set((Array.isArray(b.holidays) ? b.holidays : []).filter(d => DATE_RE.test(d)))].sort();
    if (b.alerts) {
        const a = b.alerts, cur2 = cur.alerts;
        const leads = (v, d) => (Array.isArray(v) ? [...new Set(v.map(n => Math.round(Number(n))).filter(n => n >= 1 && n <= 240))].slice(0, 5) : d);
        const ch = (c, d) => ({ notification: c?.notification ?? d.notification, email: !!(c?.email ?? d.email), whatsapp: !!(c?.whatsapp ?? d.whatsapp) });
        const sr = a.staffReminders || {}, pa = a.parentAlerts || {}, aa = a.adminAlerts || {};
        data.alertConfig = core.mergeAlerts({
            staffReminders: { enabled: sr.enabled ?? cur2.staffReminders.enabled, beforeResume: leads(sr.beforeResume, cur2.staffReminders.beforeResume), beforeLate: leads(sr.beforeLate, cur2.staffReminders.beforeLate), beforeSignOut: leads(sr.beforeSignOut, cur2.staffReminders.beforeSignOut), afterClosing: leads(sr.afterClosing, cur2.staffReminders.afterClosing), channels: ch(sr.channels, cur2.staffReminders.channels) },
            parentAlerts: { ...['enabled', 'onSignIn', 'onSignOut', 'onLate', 'onAbsent'].reduce((o, k) => ({ ...o, [k]: pa[k] ?? cur2.parentAlerts[k] }), {}), channels: ch(pa.channels, cur2.parentAlerts.channels) },
            adminAlerts: { ...['staffEvents', 'studentEvents', 'exceptions'].reduce((o, k) => ({ ...o, [k]: aa[k] ?? cur2.adminAlerts[k] }), {}), channels: ch(aa.channels, cur2.adminAlerts.channels) },
            allowUserPreferences: a.allowUserPreferences ?? cur2.allowUserPreferences,
        });
    }
    if (b.deduction) data.deductionPolicy = cleanDeduction(b.deduction);

    await prisma.attendanceSettings.update({ where: { schoolId: req.user.schoolId }, data });
    await invalidateCache(`attendance:settings:${req.user.schoolId}`);
    res.status(StatusCodes.OK).json({ msg: 'Settings saved', settings: publicSettings(await core.getSettings(req.user.schoolId)) });
};

const cleanDeduction = (d) => ({
    lateMode: ['NONE', 'PER_LATE', 'PER_MINUTE', 'PERCENT_OF_DAILY'].includes(d.lateMode) ? d.lateMode : 'NONE',
    lateAmount: num(d.lateAmount, 0, 1e9, 0), lateFreePerMonth: Math.round(num(d.lateFreePerMonth, 0, 31, 0)),
    absentMode: ['NONE', 'DAILY_RATE', 'FIXED_PER_DAY'].includes(d.absentMode) ? d.absentMode : 'NONE', absentAmount: num(d.absentAmount, 0, 1e9, 0),
    halfDayAsHalfAbsent: d.halfDayAsHalfAbsent !== false, maxPercentOfGross: num(d.maxPercentOfGross, 0, 100, 50),
});

// ─── wall QR ────────────────────────────────────────────────────────────────
const safeOrigin = (o) => (/^https?:\/\/[^/\s]+$/.test(String(o || '')) ? o : null);

const wallInfo = async (schoolId, origin) => {
    const settings = await core.rotateIfDue(await core.getSettings(schoolId));
    const token = core.wallToken(settings);
    const base = safeOrigin(origin);
    const url = base ? `${base}/teacher/attendance/wall?t=${encodeURIComponent(token)}` : token;
    const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 720 });
    return { settings, token, url, dataUrl };
};

const getWallQr = async (req, res) => {
    const w = await wallInfo(req.user.schoolId, req.query.origin);
    res.status(StatusCodes.OK).json({
        qr: w.dataUrl, url: w.url, version: w.settings.wallQrVersion, rotatedAt: w.settings.wallQrRotatedAt, autoRotateDays: w.settings.wallQrAutoRotateDays,
        enabled: w.settings.wallQrEnabled, locationSet: w.settings.schoolLat != null && w.settings.schoolLng != null, requireLocation: w.settings.requireLocationForSelfScan,
    });
};

const rotateWallQr = async (req, res) => {
    await prisma.attendanceSettings.upsert({ where: { schoolId: req.user.schoolId }, update: { wallQrVersion: { increment: 1 }, wallQrRotatedAt: new Date() }, create: { schoolId: req.user.schoolId, wallQrVersion: 2 } });
    res.status(StatusCodes.OK).json({ msg: 'A new QR code is now active. The old printed one no longer works.' });
};

const wallPoster = async (req, res) => {
    const w = await wallInfo(req.user.schoolId, req.query.origin);
    const school = await loadSchool(req.user.schoolId);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;text-align:center;color:#111}h1{font-size:30pt;margin:8px 0}h2{font-size:15pt;font-weight:normal;color:#444;margin:0 0 12px}
        img.qr{width:420px;height:420px;border:6px solid #111;border-radius:16px;padding:10px;margin:14px 0}ol{display:inline-block;text-align:left;font-size:13pt;line-height:1.6}.n{font-size:10pt;color:#777;margin-top:16px}</style></head><body>
        ${await letterhead(school, { includeLetterhead: true })}<h1>Staff Attendance</h1><h2>Scan to sign in or out</h2><img class="qr" src="${w.dataUrl}" />
        <br/><ol><li>Open your phone camera, or the Skooly app, and scan this code.</li><li>Sign in to your staff account if asked.</li><li>Allow location access — you must be inside the school.</li><li>Sign in when you arrive and sign out when you leave.</li></ol>
        <p class="n">Version ${w.settings.wallQrVersion} · printed ${new Date().toLocaleDateString('en-GB')} · Do not photograph or share this code.</p></body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
        await page.setContent(html, { waitUntil: 'load' });
        const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm' } }));
        res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'attachment; filename="staff-attendance-qr.pdf"');
        res.status(StatusCodes.OK).end(pdf);
    } finally { await page.close().catch(() => {}); }
};

// ─── staff self service ──────────────────────────────────────────────────────
const selfToday = async (req, res) => {
    const staff = await myStaff(req);
    if (!staff) throw new CustomError.NotFoundError('No staff profile is linked to your account');
    const settings = await core.rotateIfDue(await core.getSettings(req.user.schoolId));
    const sn = core.schoolNow(settings.timezone);
    const policy = await prisma.staffAttendancePolicy.findUnique({ where: { staffId: staff.id } });
    const sched = core.scheduleFor(settings, policy);
    const rec = await prisma.staffAttendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: sn.dateStr } } });
    const next = !rec?.checkInTime ? 'SIGN_IN' : !rec.checkOutTime ? 'SIGN_OUT' : 'DONE';
    res.status(StatusCodes.OK).json({
        date: sn.dateStr, timezone: settings.timezone, workday: core.isWorkday(settings, policy, sn.dateStr), next,
        schedule: { resume: core.fmtMin(sched.resume), lateAfter: core.fmtMin(sched.lateAfter), closing: core.fmtMin(sched.closing) },
        record: rec && { status: rec.status, checkIn: localHHMM(rec.checkInTime, settings.timezone), checkOut: localHHMM(rec.checkOutTime, settings.timezone), lateMinutes: rec.lateMinutes, earlyLeaveMinutes: rec.earlyLeaveMinutes },
        location: { required: settings.requireLocationForSelfScan, configured: settings.schoolLat != null, radius: settings.geoRadiusMeters },
        wallQrEnabled: settings.wallQrEnabled, name: staff.user?.name,
    });
};

const selfSign = async (req, res) => {
    const staff = await myStaff(req);
    if (!staff) throw new CustomError.NotFoundError('No staff profile is linked to your account');
    const settings = await core.rotateIfDue(await core.getSettings(req.user.schoolId));
    if (!settings.wallQrEnabled) throw new AttendanceError('Signing in with the school QR code is switched off.', 403, 'DISABLED');
    core.verifyWallToken(req.body?.wallToken, settings);
    const out = await core.staffSign({ settings, staff, method: 'WALL_QR', loc: req.body, deviceInfo: String(req.body?.deviceInfo || '').slice(0, 200), actor: { userId: req.user.userId, name: req.user.name } });
    res.status(StatusCodes.OK).json({ action: out.action, status: out.status, lateMinutes: out.lateMinutes, earlyLeaveMinutes: out.earlyLeaveMinutes, msg: out.message });
};

const rangeFromQuery = async (req, settings) => rep.resolvePeriod(req.user.schoolId, req.query.period ? req.query : { period: 'month', month: req.query.month }, settings.timezone);

const selfRecords = async (req, res) => {
    const staff = await myStaff(req);
    if (!staff) throw new CustomError.NotFoundError('No staff profile is linked to your account');
    const settings = await core.getSettings(req.user.schoolId);
    const p = await rangeFromQuery(req, settings);
    const r = await rep.staffReport(req.user.schoolId, settings, { from: p.from, to: p.to, staffId: staff.id });
    const [records, events] = await Promise.all([
        prisma.staffAttendance.findMany({ where: { staffId: staff.id, date: { gte: p.from, lte: p.to } }, orderBy: { date: 'asc' } }),
        prisma.attendanceEvent.findMany({ where: { schoolId: req.user.schoolId, userType: 'staff', userId: staff.id, occurredAt: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T23:59:59Z`) } }, orderBy: { occurredAt: 'desc' }, take: 100 }),
    ]);
    res.status(StatusCodes.OK).json({
        period: p, summary: r.rows[0] || null,
        records: records.map(x => ({ date: x.date, status: x.status, checkIn: localHHMM(x.checkInTime, settings.timezone), checkOut: localHHMM(x.checkOutTime, settings.timezone), lateMinutes: x.lateMinutes, earlyLeaveMinutes: x.earlyLeaveMinutes, method: x.signInMethod })),
        events,
    });
};

// ─── personal preferences ────────────────────────────────────────────────────
const getPreferences = async (req, res) => {
    const settings = await core.getSettings(req.user.schoolId);
    const mine = (await core.getPrefs(req.user.userId)) || {};
    res.status(StatusCodes.OK).json({
        allowed: settings.alerts.allowUserPreferences, defaults: { staff: settings.alerts.staffReminders, parent: settings.alerts.parentAlerts },
        prefs: { remindersEnabled: mine.remindersEnabled ?? true, childAlerts: mine.childAlerts ?? true, channels: mine.channels || null, events: mine.events || {}, beforeResume: mine.beforeResume || null, beforeLate: mine.beforeLate || null, beforeSignOut: mine.beforeSignOut || null },
    });
};

const putPreferences = async (req, res) => {
    const settings = await core.getSettings(req.user.schoolId);
    if (!settings.alerts.allowUserPreferences) throw new CustomError.UnauthorizedError('Your school has turned off personal attendance settings.');
    const b = req.body || {};
    const leads = (v) => (Array.isArray(v) ? [...new Set(v.map(n => Math.round(Number(n))).filter(n => n >= 1 && n <= 240))].slice(0, 5) : null);
    const config = {
        remindersEnabled: b.remindersEnabled !== false, childAlerts: b.childAlerts !== false,
        channels: b.channels ? { notification: !!b.channels.notification, email: !!b.channels.email, whatsapp: !!b.channels.whatsapp } : null,
        events: ['IN', 'OUT', 'LATE', 'ABSENT'].reduce((o, k) => ({ ...o, [k]: b.events?.[k] !== false }), {}),
        beforeResume: leads(b.beforeResume), beforeLate: leads(b.beforeLate), beforeSignOut: leads(b.beforeSignOut),
    };
    await prisma.attendancePreference.upsert({ where: { userId: req.user.userId }, update: { config }, create: { schoolId: req.user.schoolId, userId: req.user.userId, config } });
    res.status(StatusCodes.OK).json({ msg: 'Your attendance settings were saved' });
};

// ─── student register (teacher for their class, admin for any class) ────────
const formClassIds = async (req) => {
    const t = await prisma.teacherProfile.findUnique({ where: { userId: req.user.userId }, select: { id: true } });
    if (!t) return [];
    return (await prisma.class.findMany({ where: { formTeacherId: t.id, schoolId: req.user.schoolId, isDeleted: false }, select: { id: true } })).map(c => c.id);
};
const assertCanMarkClass = async (req, classId) => {
    if (isAdmin(req)) return;
    if (!(await formClassIds(req)).includes(classId)) throw new CustomError.UnauthorizedError('You can only mark attendance for the class you are the form teacher of.');
};

const markRegister = async (req, res) => {
    const { classId, date, records } = req.body || {};
    if (!classId || !DATE_RE.test(date || '') || !Array.isArray(records) || !records.length) throw new CustomError.BadRequestError('classId, date and records are required');
    await assertCanMarkClass(req, classId);
    const settings = await core.getSettings(req.user.schoolId);
    const sn = core.schoolNow(settings.timezone);
    if (date > sn.dateStr) throw new CustomError.BadRequestError('You cannot mark attendance for a future date');
    const method = isAdmin(req) ? 'ADMIN_REGISTER' : 'TEACHER_REGISTER';
    const students = await prisma.studentProfile.findMany({ where: { schoolId: req.user.schoolId, classId, id: { in: records.map(r => r.studentId) }, isDeleted: false }, include: { user: { select: { name: true } }, parent: { include: { user: { select: { id: true, email: true, name: true } } } }, classArm: { select: { name: true } } } });
    const byId = new Map(students.map(s => [s.id, s]));
    const existing = await prisma.attendanceRecord.findMany({ where: { date, studentProfileId: { in: students.map(s => s.id) } } });
    const exMap = new Map(existing.map(e => [e.studentProfileId, e]));
    const today = date === sn.dateStr, now = new Date();
    let n = 0;
    for (const r of records) {
        const st = byId.get(r.studentId);
        if (!st || !['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'].includes(r.status || 'PRESENT')) continue;
        const status = r.status || 'PRESENT';
        const prev = exMap.get(st.id);
        const attended = status === 'PRESENT' || status === 'LATE';
        const data = { classId, status, note: r.note || null, markedBy: req.user.name, signInTime: attended ? (prev?.signInTime || (today ? now : zoned(date, settings.schoolStartTime, settings.timezone))) : null, signInMethod: attended ? (prev?.signInMethod || method) : null, ...(attended ? {} : { signOutTime: null, signOutMethod: null }) };
        await prisma.attendanceRecord.upsert({ where: { studentProfileId_date: { studentProfileId: st.id, date } }, create: { schoolId: req.user.schoolId, studentProfileId: st.id, date, ...data }, update: data });
        n++;
        if (prev?.status !== status) {
            await core.logEvent({ schoolId: req.user.schoolId, userType: 'student', userId: st.id, userName: st.user?.name, classId, className: st.classArm?.name, action: attended ? 'SIGN_IN' : 'MARKED', method, status, actorUserId: req.user.userId, actorName: req.user.name, occurredAt: today ? now : zoned(date, '12:00', settings.timezone) });
            if (today) await core.alertParent(settings, st, status === 'LATE' ? 'LATE' : status === 'PRESENT' ? 'IN' : status === 'ABSENT' ? 'ABSENT' : null, now).catch(e => console.error('[attendance] parent alert failed:', e.message));
        }
    }
    res.status(StatusCodes.OK).json({ msg: `Attendance marked for ${n} students`, count: n });
};

const markRegisterOut = async (req, res) => {
    const { classId, date, studentIds } = req.body || {};
    if (!classId || !DATE_RE.test(date || '') || !Array.isArray(studentIds) || !studentIds.length) throw new CustomError.BadRequestError('classId, date and studentIds are required');
    await assertCanMarkClass(req, classId);
    const settings = await core.getSettings(req.user.schoolId);
    if (!settings.studentSignOutEnabled) throw new CustomError.BadRequestError('Student sign-out is switched off in Attendance settings.');
    const sn = core.schoolNow(settings.timezone), today = date === sn.dateStr, now = new Date();
    const method = isAdmin(req) ? 'ADMIN_REGISTER' : 'TEACHER_REGISTER';
    const students = await prisma.studentProfile.findMany({ where: { schoolId: req.user.schoolId, classId, id: { in: studentIds } }, include: { user: { select: { name: true } }, parent: { include: { user: { select: { id: true, email: true, name: true } } } }, classArm: { select: { name: true } } } });
    let n = 0;
    for (const st of students) {
        const rec = await prisma.attendanceRecord.findUnique({ where: { studentProfileId_date: { studentProfileId: st.id, date } } });
        if (!rec || !['PRESENT', 'LATE'].includes(rec.status) || rec.signOutTime) continue;
        const at = today ? now : zoned(date, settings.studentClosingTime, settings.timezone);
        await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { signOutTime: at, signOutMethod: method } });
        await core.logEvent({ schoolId: req.user.schoolId, userType: 'student', userId: st.id, userName: st.user?.name, classId, className: st.classArm?.name, action: 'SIGN_OUT', method, status: rec.status, actorUserId: req.user.userId, actorName: req.user.name, occurredAt: at });
        if (today) await core.alertParent(settings, st, 'OUT', now).catch(() => {});
        n++;
    }
    res.status(StatusCodes.OK).json({ msg: `${n} student${n === 1 ? '' : 's'} signed out`, count: n });
};

// ─── staff register (admin ticks for everyone) ──────────────────────────────
const staffRoster = async (req, res) => {
    const settings = await core.getSettings(req.user.schoolId);
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : core.schoolNow(settings.timezone).dateStr;
    const [staff, recs, policies] = await Promise.all([
        prisma.teacherProfile.findMany({ where: { schoolId: req.user.schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] } }, include: { user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } } }),
        prisma.staffAttendance.findMany({ where: { schoolId: req.user.schoolId, date } }),
        prisma.staffAttendancePolicy.findMany({ where: { schoolId: req.user.schoolId } }),
    ]);
    const rm = new Map(recs.map(r => [r.staffId, r])), pm = new Map(policies.map(p => [p.staffId, p]));
    res.status(StatusCodes.OK).json({
        date, workday: core.isWorkday(settings, null, date), holiday: core.isHoliday(settings, date), schedule: { resume: settings.staffResumeTime, lateAfter: settings.staffLateAfterTime, closing: settings.staffClosingTime },
        roster: staff.map(s => {
            const r = rm.get(s.id);
            return { staffId: s.id, name: s.user?.name || s.employeeId, employeeId: s.employeeId, department: s.department || '', exempt: !!pm.get(s.id)?.exempt, record: r ? { status: r.status, checkIn: localHHMM(r.checkInTime, settings.timezone), checkOut: localHHMM(r.checkOutTime, settings.timezone), lateMinutes: r.lateMinutes, method: r.signInMethod || r.markedBy, note: r.note } : null };
        }),
    });
};

const staffMarkBulk = async (req, res) => {
    const { date, records } = req.body || {};
    if (!DATE_RE.test(date || '') || !Array.isArray(records) || !records.length) throw new CustomError.BadRequestError('date and records are required');
    const settings = await core.getSettings(req.user.schoolId);
    if (date > core.schoolNow(settings.timezone).dateStr) throw new CustomError.BadRequestError('You cannot mark attendance for a future date');
    const staff = await prisma.teacherProfile.findMany({ where: { schoolId: req.user.schoolId, id: { in: records.map(r => r.staffId) } }, include: { user: { select: { name: true } } } });
    const sm = new Map(staff.map(s => [s.id, s]));
    const existing = await prisma.staffAttendance.findMany({ where: { date, staffId: { in: staff.map(s => s.id) } } });
    const em = new Map(existing.map(e => [e.staffId, e]));
    const policies = await prisma.staffAttendancePolicy.findMany({ where: { staffId: { in: staff.map(s => s.id) } } });
    const pm = new Map(policies.map(p => [p.staffId, p]));
    let n = 0;
    for (const r of records) {
        const s = sm.get(r.staffId);
        if (!s || !['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'].includes(r.status)) continue;
        if (r.checkInTime && !TIME_RE.test(r.checkInTime)) throw new CustomError.BadRequestError(`Invalid sign-in time for ${s.user?.name}`);
        if (r.checkOutTime && !TIME_RE.test(r.checkOutTime)) throw new CustomError.BadRequestError(`Invalid sign-out time for ${s.user?.name}`);
        const sched = core.scheduleFor(settings, pm.get(s.id));
        const absent = r.status === 'ABSENT' || r.status === 'EXCUSED';
        const inAt = !absent && r.checkInTime ? zoned(date, r.checkInTime, settings.timezone) : null;
        const outAt = !absent && r.checkOutTime ? zoned(date, r.checkOutTime, settings.timezone) : null;
        const lateMinutes = r.status === 'LATE' && r.checkInTime ? Math.max(0, core.toMin(r.checkInTime) - sched.resume) : 0;
        const early = outAt && r.checkOutTime ? Math.max(0, sched.closing - core.toMin(r.checkOutTime)) : 0;
        const data = { status: r.status, note: r.note || null, markedBy: 'ADMIN_OVERRIDE', checkInTime: inAt ?? (absent ? null : em.get(s.id)?.checkInTime ?? null), checkOutTime: outAt ?? (absent ? null : em.get(s.id)?.checkOutTime ?? null), signInMethod: absent ? null : em.get(s.id)?.signInMethod || 'ADMIN_REGISTER', lateMinutes, earlyLeaveMinutes: early };
        await prisma.staffAttendance.upsert({ where: { staffId_date: { staffId: s.id, date } }, create: { schoolId: req.user.schoolId, staffId: s.id, date, ...data }, update: data });
        const prev = em.get(s.id);
        if (!prev || prev.status !== r.status || (r.checkInTime && localHHMM(prev.checkInTime, settings.timezone) !== r.checkInTime) || (r.checkOutTime && localHHMM(prev.checkOutTime, settings.timezone) !== r.checkOutTime)) {
            await core.logEvent({ schoolId: req.user.schoolId, userType: 'staff', userId: s.id, userName: s.user?.name, action: r.checkOutTime && !r.checkInTime ? 'SIGN_OUT' : absent ? 'MARKED' : 'SIGN_IN', method: 'ADMIN_REGISTER', status: r.status, lateMinutes, actorUserId: req.user.userId, actorName: req.user.name, note: r.note || null, occurredAt: inAt || new Date() });
        }
        n++;
    }
    res.status(StatusCodes.OK).json({ msg: `Attendance saved for ${n} staff`, count: n });
};

// ─── activity log ────────────────────────────────────────────────────────────
const listEvents = async (req, res) => {
    const { userType, action, method, userId, q, from, to } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1), take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = {
        schoolId: req.user.schoolId, ...(userType && { userType }), ...(action && { action }), ...(method && { method }), ...(userId && { userId }),
        ...(q && { userName: { contains: String(q), mode: 'insensitive' } }),
        ...((from || to) && { occurredAt: { ...(DATE_RE.test(from || '') && { gte: new Date(`${from}T00:00:00Z`) }), ...(DATE_RE.test(to || '') && { lte: new Date(`${to}T23:59:59Z`) }) } }),
    };
    const [total, events] = await Promise.all([prisma.attendanceEvent.count({ where }), prisma.attendanceEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * take, take })]);
    res.status(StatusCodes.OK).json({ total, page, pages: Math.ceil(total / take), events });
};

// ─── dashboard ───────────────────────────────────────────────────────────────
const dashboard = async (req, res) => {
    const schoolId = req.user.schoolId;
    const settings = await core.getSettings(schoolId);
    const sn = core.schoolNow(settings.timezone);
    const [students, staffTotal, staffRecs, studentRecs, events] = await Promise.all([
        prisma.studentProfile.count({ where: { schoolId, status: 'Active', isDeleted: false } }),
        prisma.teacherProfile.count({ where: { schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] } } }),
        prisma.staffAttendance.findMany({ where: { schoolId, date: sn.dateStr }, include: { staff: { include: { user: { select: { name: true } } } } } }),
        prisma.attendanceRecord.groupBy({ by: ['status'], where: { schoolId, date: sn.dateStr, isDeleted: false }, _count: { _all: true } }),
        prisma.attendanceEvent.findMany({ where: { schoolId }, orderBy: { occurredAt: 'desc' }, take: 12 }),
    ]);
    const sc = Object.fromEntries(studentRecs.map(g => [g.status, g._count._all]));
    const staffIn = staffRecs.filter(r => r.checkInTime);
    const rejected = await prisma.attendanceEvent.count({ where: { schoolId, action: 'REJECTED', occurredAt: { gte: new Date(Date.now() - 86400000) } } });
    res.status(StatusCodes.OK).json({
        date: sn.dateStr, workday: core.isWorkday(settings, null, sn.dateStr), holiday: core.isHoliday(settings, sn.dateStr),
        students: { total: students, present: sc.PRESENT || 0, late: sc.LATE || 0, absent: sc.ABSENT || 0, excused: sc.EXCUSED || 0, marked: Object.values(sc).reduce((a, b) => a + b, 0) },
        staff: {
            total: staffTotal, signedIn: staffIn.length, signedOut: staffRecs.filter(r => r.checkOutTime).length, late: staffRecs.filter(r => r.status === 'LATE').length, absent: staffRecs.filter(r => r.status === 'ABSENT').length,
            notYet: staffTotal - staffRecs.length, lateList: staffRecs.filter(r => r.status === 'LATE').map(r => ({ name: r.staff.user?.name, minutes: r.lateMinutes })).slice(0, 8),
        },
        rejectedLast24h: rejected, events, locationSet: settings.schoolLat != null,
    });
};

// ─── reports ────────────────────────────────────────────────────────────────
const buildReport = async (req, kind) => {
    const settings = await core.getSettings(req.user.schoolId);
    const period = await rep.resolvePeriod(req.user.schoolId, req.query, settings.timezone);
    const { classId, studentId, staffId } = req.query;
    let report, scope;
    if (kind === 'staff') {
        report = await rep.staffReport(req.user.schoolId, settings, { from: period.from, to: period.to, staffId });
        scope = staffId ? (report.rows[0]?.name || 'Staff member') : 'All staff';
    } else {
        let classIds;
        if (!isAdmin(req)) { classIds = await formClassIds(req); if (classId && !classIds.includes(classId)) throw new CustomError.UnauthorizedError('You can only view reports for your own class.'); if (!classId && !classIds.length) classIds = ['none']; }
        report = await rep.studentReport(req.user.schoolId, { from: period.from, to: period.to, classId, studentId, ...(classIds && !classId && { classIds }) });
        const cls = classId ? await prisma.class.findFirst({ where: { id: classId, schoolId: req.user.schoolId }, select: { name: true } }) : null;
        scope = studentId ? (report.rows[0]?.name || 'Student') : cls ? cls.name : 'Whole school';
    }
    return { report, period, scope };
};

const reportJson = (kind) => async (req, res) => {
    const { report, period, scope } = await buildReport(req, kind);
    res.status(StatusCodes.OK).json({ period, scope, ...report });
};

const exportReport = (kind) => async (req, res) => {
    const { report, period, scope } = await buildReport(req, kind);
    const school = await loadSchool(req.user.schoolId);
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'pdf';
    const buffer = format === 'xlsx' ? rep.toXlsx({ rep: report, label: period.label, scopeLabel: scope, school }) : await rep.toPdf({ rep: report, label: period.label, scopeLabel: scope, school, cfg: { includeLetterhead: true } });
    const name = `${kind}-attendance-${scope}-${period.from}-${period.to}`.replace(/[^\w\-]+/g, '_').slice(0, 90);
    res.setHeader('Content-Type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
    res.status(StatusCodes.OK).end(buffer);
};

// ─── student / parent view (replaces the month-only endpoint) ───────────────
const myAttendance = async (req, res) => {
    const { studentProfileId } = req.query;
    let sid = studentProfileId;
    if (req.user.role === 'STUDENT') {
        const st = await prisma.studentProfile.findUnique({ where: { userId: req.user.userId } });
        if (!st) throw new CustomError.NotFoundError('Student profile not found');
        sid = st.id;
    } else if (req.user.role === 'PARENT') {
        if (!sid) throw new CustomError.BadRequestError('studentProfileId query parameter is required for parents');
        const parent = await prisma.parentProfile.findUnique({ where: { userId: req.user.userId }, include: { students: { select: { id: true } } } });
        if (!parent?.students.some(c => c.id === sid)) throw new CustomError.UnauthorizedError('Not authorized to view this student');
    } else throw new CustomError.UnauthorizedError('Only students and parents can use this endpoint');

    const settings = await core.getSettings(req.user.schoolId);
    const q = req.query.period ? req.query : { period: 'month', month: req.query.year && req.query.month ? `${req.query.year}-${pad(req.query.month)}` : undefined };
    const period = await rep.resolvePeriod(req.user.schoolId, q, settings.timezone);
    const records = await prisma.attendanceRecord.findMany({ where: { studentProfileId: sid, isDeleted: false, date: { gte: period.from, lte: period.to } }, orderBy: { date: 'asc' } });
    const count = (s) => records.filter(r => r.status === s).length;
    const events = await prisma.attendanceEvent.findMany({ where: { schoolId: req.user.schoolId, userType: 'student', userId: sid, occurredAt: { gte: new Date(`${period.from}T00:00:00Z`), lte: new Date(`${period.to}T23:59:59Z`) } }, orderBy: { occurredAt: 'desc' }, take: 60 });
    res.status(StatusCodes.OK).json({
        period, records: records.map(r => ({ ...r, signIn: localHHMM(r.signInTime, settings.timezone), signOut: localHHMM(r.signOutTime, settings.timezone) })),
        summary: { present: count('PRESENT'), absent: count('ABSENT'), late: count('LATE'), excused: count('EXCUSED') }, events,
    });
};

// ─── per-staff arrangements & payroll ───────────────────────────────────────
const listPolicies = async (req, res) => {
    const settings = await core.getSettings(req.user.schoolId);
    const [staff, policies] = await Promise.all([
        prisma.teacherProfile.findMany({ where: { schoolId: req.user.schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] } }, include: { user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } } }),
        prisma.staffAttendancePolicy.findMany({ where: { schoolId: req.user.schoolId } }),
    ]);
    const pm = new Map(policies.map(p => [p.staffId, p]));
    res.status(StatusCodes.OK).json({
        schoolDefault: { resumeTime: settings.staffResumeTime, lateAfterTime: settings.staffLateAfterTime, closingTime: settings.staffClosingTime, workDays: settings.workDays, deduction: settings.deduction },
        staff: staff.map(s => { const p = pm.get(s.id); return { staffId: s.id, name: s.user?.name || s.employeeId, employeeId: s.employeeId, policy: p ? { exempt: p.exempt, useSchoolSchedule: p.useSchoolSchedule, resumeTime: p.resumeTime, lateAfterTime: p.lateAfterTime, closingTime: p.closingTime, workDays: p.workDays, useSchoolDeduction: p.useSchoolDeduction, deduction: p.deduction ? core.mergeDeduction(p.deduction) : null } : null }; }),
    });
};

const putPolicy = async (req, res) => {
    const s = await prisma.teacherProfile.findFirst({ where: { id: req.params.staffId, schoolId: req.user.schoolId } });
    if (!s) throw new CustomError.NotFoundError('Staff not found');
    const b = req.body || {};
    const t = (v) => (v && TIME_RE.test(v) ? v : null);
    const data = {
        exempt: !!b.exempt, useSchoolSchedule: b.useSchoolSchedule !== false, resumeTime: t(b.resumeTime), lateAfterTime: t(b.lateAfterTime), closingTime: t(b.closingTime),
        workDays: (Array.isArray(b.workDays) ? b.workDays : []).filter(d => core.WEEKDAYS.includes(d)), useSchoolDeduction: b.useSchoolDeduction !== false, deduction: b.deduction ? cleanDeduction(b.deduction) : null,
    };
    if (!data.useSchoolSchedule && (!data.resumeTime || !data.closingTime)) throw new CustomError.BadRequestError('Give a resume time and closing time for a personal schedule');
    if (!data.useSchoolSchedule && !data.lateAfterTime) data.lateAfterTime = data.resumeTime;
    await prisma.staffAttendancePolicy.upsert({ where: { staffId: s.id }, update: data, create: { schoolId: req.user.schoolId, staffId: s.id, ...data } });
    res.status(StatusCodes.OK).json({ msg: 'Staff attendance arrangement saved' });
};

const payrollImpact = async (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : core.schoolNow('Africa/Lagos').dateStr.slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const from = `${m}-01`, to = `${m}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
    const staff = await prisma.teacherProfile.findMany({ where: { schoolId: req.user.schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] } }, include: { user: { select: { name: true } }, payrollSettings: true } });
    const gross = Object.fromEntries(staff.map(s => [s.id, s.payrollSettings.filter(p => p.type === 'earning').reduce((n, p) => n + p.amount, 0)]));
    const d = await computeStaffDeductions({ schoolId: req.user.schoolId, from, to, grossByStaff: gross });
    const settings = await core.getSettings(req.user.schoolId);
    res.status(StatusCodes.OK).json({
        month: m, autoDeduct: settings.autoDeductInPayroll,
        rows: staff.map(s => ({ staffId: s.id, name: s.user?.name || s.employeeId, gross: gross[s.id], ...d[s.id] })).sort((a, b) => b.amount - a.amount),
        totalDeduction: Math.round(Object.values(d).reduce((n, x) => n + x.amount, 0) * 100) / 100,
    });
};

const reportOptions = async (req, res) => {
    const schoolId = req.user.schoolId;
    const [sessions, terms, classes] = await Promise.all([
        prisma.academicSession.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true, isCurrent: true }, orderBy: { createdAt: 'desc' } }),
        prisma.academicTerm.findMany({ where: { schoolId }, select: { id: true, name: true, sessionId: true, startDate: true, endDate: true, isActive: true }, orderBy: { startDate: 'desc' } }),
        isAdmin(req) ? prisma.class.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true }, orderBy: [{ order: 'asc' }, { name: 'asc' }] })
            : prisma.class.findMany({ where: { id: { in: await formClassIds(req) } }, select: { id: true, name: true } }),
    ]);
    res.status(StatusCodes.OK).json({ sessions, terms, classes, isAdmin: isAdmin(req) });
};

const myChildren = async (req, res) => {
    const parent = await prisma.parentProfile.findUnique({ where: { userId: req.user.userId }, include: { students: { where: { isDeleted: false }, include: { user: { select: { name: true } }, classArm: { select: { name: true } } } } } });
    if (!parent) throw new CustomError.NotFoundError('Parent profile not found');
    res.status(StatusCodes.OK).json({ children: parent.students.map(c => ({ studentProfileId: c.id, name: c.user?.name, admissionNo: c.admissionNo, className: c.classArm?.name || '' })) });
};

module.exports = {
    myChildren, reportOptions, guard, getSettings, updateSettings, getWallQr, rotateWallQr, wallPoster, selfToday, selfSign, selfRecords, getPreferences, putPreferences,
    markRegister, markRegisterOut, staffRoster, staffMarkBulk, listEvents, dashboard, reportJson, exportReport, myAttendance, listPolicies, putPolicy, payrollImpact,
};
