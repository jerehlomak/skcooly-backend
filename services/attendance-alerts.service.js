const prisma = require('../db/prisma');
const core = require('./attendance-core.service');

const WINDOW = 3; // minutes of tolerance so a late tick doesn't skip a reminder (the dedupe key stops repeats)
const due = (target, now) => target <= now && target > now - WINDOW;

const leadText = (m) => `${m} minute${m === 1 ? '' : 's'}`;

/** Reminders for one school: resume / late-cutoff / sign-out, then the end-of-day close. */
const processSchool = async (schoolId) => {
    const settings = await core.getSettings(schoolId);
    const sn = core.schoolNow(settings.timezone);
    const cfg = settings.alerts.staffReminders;
    if (core.isHoliday(settings, sn.dateStr)) return;

    const [staff, policies, records] = await Promise.all([
        prisma.teacherProfile.findMany({ where: { schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] } }, include: { user: { select: { id: true, email: true, name: true } } } }),
        prisma.staffAttendancePolicy.findMany({ where: { schoolId } }),
        prisma.staffAttendance.findMany({ where: { schoolId, date: sn.dateStr } }),
    ]);
    const pol = new Map(policies.map(p => [p.staffId, p]));
    const rec = new Map(records.map(r => [r.staffId, r]));

    for (const s of staff) {
        const p = pol.get(s.id);
        if (p?.exempt || !core.isWorkday(settings, p, sn.dateStr)) continue;
        const sched = core.scheduleFor(settings, p);
        const r = rec.get(s.id);
        const signedIn = !!r?.checkInTime, signedOut = !!r?.checkOutTime;
        const prefs = await core.getPrefs(s.userId);
        if (settings.alerts.allowUserPreferences && prefs?.remindersEnabled === false) continue;
        const mine = (k) => (settings.alerts.allowUserPreferences && Array.isArray(prefs?.[k]) && prefs[k].length ? prefs[k] : cfg[k]);

        const send = async (type, lead, title, message) => {
            if (!(await core.claim(`ATTR|${schoolId}|${sn.dateStr}|${s.id}|${type}|${lead}`))) return;
            await core.notifyUser({ schoolId, user: s.user, channels: cfg.channels, prefs, allowPrefs: settings.alerts.allowUserPreferences, title, message, link: '/teacher/attendance/me' }).catch(() => {});
        };
        if (cfg.enabled && !signedIn) {
            for (const lead of mine('beforeResume')) if (due(sched.resume - lead, sn.minutes)) await send('RES', lead, 'Resume soon', `Work resumes in ${leadText(lead)} (${core.fmtMin(sched.resume)}). Remember to sign in once you are at school.`);
            for (const lead of mine('beforeLate')) if (due(sched.lateAfter - lead, sn.minutes)) await send('LATE', lead, 'Sign in now', `Only ${leadText(lead)} left before you are marked late (${core.fmtMin(sched.lateAfter)}).`);
        }
        if (cfg.enabled && signedIn && !signedOut) {
            for (const lead of mine('beforeSignOut')) if (due(sched.closing - lead, sn.minutes)) await send('OUT', lead, 'Closing soon', `Closing time is in ${leadText(lead)} (${core.fmtMin(sched.closing)}). Remember to sign out when you leave.`);
            for (const lead of mine('afterClosing')) if (due(sched.closing + lead, sn.minutes)) await send('FORGOT', lead, 'Did you forget to sign out?', `Closing time was ${core.fmtMin(sched.closing)}. If you have left, sign out now.`);
        }
    }

    // end of day: staff with no record at all become ABSENT, so reports and payroll are deterministic
    if (settings.autoMarkStaffAbsent && sn.minutes >= core.toMin(settings.autoCloseTime || '17:00') && await core.claim(`ATTC|${schoolId}|${sn.dateStr}`)) {
        const missing = staff.filter(s => !rec.has(s.id) && !pol.get(s.id)?.exempt && core.isWorkday(settings, pol.get(s.id), sn.dateStr));
        if (missing.length) {
            await prisma.staffAttendance.createMany({ data: missing.map(s => ({ schoolId, staffId: s.id, date: sn.dateStr, status: 'ABSENT', markedBy: 'AUTO' })), skipDuplicates: true });
            await prisma.attendanceEvent.createMany({ data: missing.map(s => ({ schoolId, userType: 'staff', userId: s.id, userName: s.user?.name || s.employeeId, action: 'MARKED', method: 'AUTO', status: 'ABSENT', note: 'No sign-in recorded today' })) });
            await core.alertAdmins(settings, { title: 'Staff absent today', message: `${missing.length} staff member${missing.length === 1 ? '' : 's'} had no sign-in today: ${missing.slice(0, 5).map(s => s.user?.name).join(', ')}${missing.length > 5 ? '…' : ''}.`, exception: true });
        }
    }
};

let running = false;
const tick = async () => {
    if (running) return;
    running = true;
    try {
        const schools = await prisma.attendanceSettings.findMany({ select: { schoolId: true } });
        for (const s of schools) await processSchool(s.schoolId).catch((e) => console.error('[attendance-alerts] school failed:', s.schoolId, e.message));
    } catch (e) { console.error('[attendance-alerts] tick failed:', e.message); } finally { running = false; }
};

let timer = null;
const startAttendanceAlerts = () => {
    if (timer) return;
    timer = setInterval(tick, 60 * 1000);
    timer.unref?.();
    console.log('[attendance-alerts] scheduler started (every 60s)');
};

module.exports = { startAttendanceAlerts, processSchool, tick };
