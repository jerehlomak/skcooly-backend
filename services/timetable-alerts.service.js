const prisma = require('../db/prisma');
const { getTransporter, getFromEmail } = require('../utils/emailTransporter');
const { sendTermiiMessage } = require('./termii.service');
const { toMin } = require('./timetable-engine.service');

const DEFAULT_ALERT_CONFIG = {
    enabled: false,
    teacher: { enabled: true, leadMinutes: [120, 10], channels: { notification: true, email: false, whatsapp: false } },
    student: { enabled: true, leadMinutes: [10], channels: { notification: true, email: false, whatsapp: false } },
    parent: { enabled: false, leadMinutes: [30], firstPeriodOnly: true, channels: { notification: true, email: false, whatsapp: false } },
};

const mergeAlertConfig = (saved) => ({
    enabled: saved?.enabled ?? DEFAULT_ALERT_CONFIG.enabled,
    teacher: { ...DEFAULT_ALERT_CONFIG.teacher, ...saved?.teacher, channels: { ...DEFAULT_ALERT_CONFIG.teacher.channels, ...saved?.teacher?.channels } },
    student: { ...DEFAULT_ALERT_CONFIG.student, ...saved?.student, channels: { ...DEFAULT_ALERT_CONFIG.student.channels, ...saved?.student?.channels } },
    parent: { ...DEFAULT_ALERT_CONFIG.parent, ...saved?.parent, channels: { ...DEFAULT_ALERT_CONFIG.parent.channels, ...saved?.parent?.channels } },
});

/** Current weekday / date / minutes-since-midnight in the school's timezone. */
const schoolNow = (timezone = 'Africa/Lagos', at = new Date()) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map(p => [p.type, p.value]));
    return { weekday: parts.weekday, dateStr: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

/**
 * Delivers one message to one user over the chosen channels. Each channel fails independently.
 * `channels` accepts either { notification, email, whatsapp } booleans or ['NOTIFICATION','EMAIL','WHATSAPP'].
 */
const deliver = async ({ schoolId, user, phone, channels, title, message, link, type = 'TIMETABLE' }) => {
    const want = Array.isArray(channels)
        ? { notification: channels.includes('NOTIFICATION'), email: channels.includes('EMAIL'), whatsapp: channels.includes('WHATSAPP') }
        : channels;
    const result = { notification: false, email: false, whatsapp: false };

    if (want.notification) {
        try { await prisma.userNotification.create({ data: { schoolId, userId: user.id, title, message, link: link || null, type } }); result.notification = true; }
        catch (e) { console.error('[timetable-alerts] notification failed:', e.message); }
    }
    if (want.email && user.email) {
        try {
            const transporter = await getTransporter(schoolId);
            await transporter.sendMail({
                from: await getFromEmail(schoolId), to: user.email, subject: title,
                html: `<div style="font-family:sans-serif"><h3>${title}</h3><p>${message}</p></div>`,
            });
            result.email = true;
        } catch (e) { console.error('[timetable-alerts] email failed:', e.message); }
    }
    if (want.whatsapp && phone) {
        try { await sendTermiiMessage(phone, `${title}\n${message}`, 'whatsapp'); result.whatsapp = true; }
        catch (e) { console.error('[timetable-alerts] whatsapp failed:', e.message); }
    }
    return result;
};

// ─── user reminders ──────────────────────────────────────────────────────────
const lookupPhone = async (schoolId, userId) => {
    const [t, s, p] = await Promise.all([
        prisma.teacherProfile.findFirst({ where: { userId, schoolId }, select: { phone: true } }),
        prisma.studentProfile.findFirst({ where: { userId, schoolId }, select: { phone: true } }),
        prisma.parentProfile.findFirst({ where: { userId, schoolId }, select: { phone: true } }),
    ]);
    return t?.phone || s?.phone || p?.phone || null;
};

const processReminders = async () => {
    const due = await prisma.timetableReminder.findMany({ where: { status: 'PENDING', remindAt: { lte: new Date() } }, take: 200 });
    for (const r of due) {
        // claim it so a second instance doesn't send it again
        const claim = await prisma.timetableReminder.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'SENDING' } });
        if (claim.count !== 1) continue;
        try {
            const user = await prisma.user.findUnique({ where: { id: r.userId }, select: { id: true, email: true, name: true } });
            if (!user) throw new Error('user missing');
            const out = await deliver({
                schoolId: r.schoolId, user, phone: await lookupPhone(r.schoolId, r.userId), channels: r.channels,
                title: `Reminder: ${r.title}`, message: r.note || r.title,
            });
            const ok = Object.values(out).some(Boolean);
            await prisma.timetableReminder.update({ where: { id: r.id }, data: { status: ok ? 'SENT' : 'FAILED', sentAt: new Date() } });
        } catch (e) {
            console.error('[timetable-alerts] reminder failed:', e.message);
            await prisma.timetableReminder.update({ where: { id: r.id }, data: { status: 'FAILED' } });
        }
    }
};

// ─── period alerts ───────────────────────────────────────────────────────────
const claimKey = async (key) => (await prisma.timetableAlertLog.createMany({ data: [{ key }], skipDuplicates: true })).count === 1;

const fmtRange = (s) => `${s.startTime}–${s.endTime}`;

const processSchool = async (settings) => {
    const cfg = mergeAlertConfig(settings.timetableAlertConfig);
    if (!cfg.enabled) return;
    const schoolId = settings.schoolId;
    const now = schoolNow(settings.timezone || 'Africa/Lagos');
    const WINDOW = 3; // minutes of tolerance so a late tick doesn't skip an alert (dedupe log prevents repeats)

    const audiences = ['teacher', 'student', 'parent'].filter(a => cfg[a].enabled && cfg[a].leadMinutes?.length);
    if (!audiences.length) return;

    const timetables = await prisma.timetable.findMany({ where: { schoolId, status: 'PUBLISHED', isDeleted: false }, select: { id: true, kind: true, name: true } });
    if (!timetables.length) return;

    const slots = await prisma.timetableSlot.findMany({
        where: {
            timetableId: { in: timetables.map(t => t.id) },
            OR: [{ day: now.weekday }, { date: new Date(`${now.dateStr}T00:00:00.000Z`) }],
        },
        orderBy: { startTime: 'asc' },
    });
    if (!slots.length) return;

    const classIds = [...new Set(slots.map(s => s.classId))];
    const classes = await prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } });
    const className = new Map(classes.map(c => [c.id, c.name]));
    const firstOfDay = new Map(); // classId|timetable → earliest start
    slots.forEach(s => { const k = `${s.timetableId}|${s.classId}`; if (!firstOfDay.has(k) || toMin(s.startTime) < toMin(firstOfDay.get(k))) firstOfDay.set(k, s.startTime); });

    for (const slot of slots) {
        const startMin = toMin(slot.startTime);
        for (const audience of audiences) {
            for (const lead of cfg[audience].leadMinutes) {
                const fireAt = startMin - Number(lead);
                if (!(fireAt <= now.minutes && fireAt > now.minutes - WINDOW)) continue;
                if (audience === 'parent' && cfg.parent.firstPeriodOnly && firstOfDay.get(`${slot.timetableId}|${slot.classId}`) !== slot.startTime) continue;
                if (!(await claimKey(`${slot.id}|${now.dateStr}|${audience}|${lead}`))) continue;

                const cName = className.get(slot.classId) || 'class';
                const leadText = lead >= 60 && lead % 60 === 0 ? `${lead / 60} hour(s)` : `${lead} minutes`;
                const kindWord = slot.slotType === 'EXAM' ? 'exam paper' : slot.slotType === 'ACTIVITY' ? 'activity' : 'class';
                const link = '/' + (audience === 'teacher' ? 'teacher' : audience === 'parent' ? 'parent' : 'student') + '/timetable';

                let recipients = []; // [{ user, phone, text }]
                if (audience === 'teacher') {
                    if (!slot.teacherId) continue;
                    const t = await prisma.teacherProfile.findFirst({ where: { id: slot.teacherId, schoolId }, include: { user: { select: { id: true, email: true, name: true } } } });
                    if (t) recipients.push({ user: t.user, phone: t.phone, text: `You have ${slot.title} with ${cName} in ${leadText} (${fmtRange(slot)}${slot.room ? ', ' + slot.room : ''}).` });
                } else {
                    const students = await prisma.studentProfile.findMany({
                        where: { schoolId, classId: slot.classId, isDeleted: false, status: 'Active' },
                        include: { user: { select: { id: true, email: true, name: true } }, parent: { include: { user: { select: { id: true, email: true, name: true } } } } },
                    });
                    if (audience === 'student') {
                        recipients = students.map(s => ({ user: s.user, phone: s.phone, text: `${slot.title} ${kindWord} starts in ${leadText} (${fmtRange(slot)}${slot.room ? ', ' + slot.room : ''}).` }));
                    } else {
                        const seen = new Set();
                        students.forEach(s => {
                            if (!s.parent || seen.has(s.parent.userId + s.id)) return;
                            seen.add(s.parent.userId + s.id);
                            recipients.push({ user: s.parent.user, phone: s.parent.phone, text: `${s.user.name}'s ${slot.title} ${kindWord} starts in ${leadText} (${fmtRange(slot)}).` });
                        });
                    }
                }
                for (const r of recipients) {
                    await deliver({
                        schoolId, user: r.user, phone: r.phone, channels: cfg[audience].channels,
                        title: slot.slotType === 'LESSON' ? 'Upcoming period' : slot.slotType === 'EXAM' ? 'Upcoming exam' : 'Upcoming activity',
                        message: r.text, link,
                    });
                }
            }
        }
    }
};

let running = false;
const tick = async () => {
    if (running) return;
    running = true;
    try {
        await processReminders();
        const all = await prisma.schoolSettings.findMany({ where: { schoolId: { not: null } }, select: { schoolId: true, timezone: true, timetableAlertConfig: true } });
        for (const s of all) { if (s.timetableAlertConfig) await processSchool(s).catch(e => console.error('[timetable-alerts] school failed:', s.schoolId, e.message)); }
    } catch (e) {
        console.error('[timetable-alerts] tick failed:', e.message);
    } finally {
        running = false;
    }
};

let timer = null;
const startTimetableAlerts = () => {
    if (timer) return;
    timer = setInterval(tick, 60 * 1000);
    timer.unref?.();
    console.log('[timetable-alerts] scheduler started (every 60s)');
};

module.exports = { startTimetableAlerts, deliver, mergeAlertConfig, DEFAULT_ALERT_CONFIG, schoolNow, tick };
