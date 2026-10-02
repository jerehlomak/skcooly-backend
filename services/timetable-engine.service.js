const prisma = require('../db/prisma');

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const COLORS = [
    'bg-blue-100 text-blue-700 border-blue-200', 'bg-emerald-100 text-emerald-700 border-emerald-200',
    'bg-amber-100 text-amber-700 border-amber-200', 'bg-purple-100 text-purple-700 border-purple-200',
    'bg-pink-100 text-pink-700 border-pink-200', 'bg-teal-100 text-teal-700 border-teal-200',
    'bg-red-100 text-red-700 border-red-200', 'bg-indigo-100 text-indigo-700 border-indigo-200',
];

const DEFAULT_CONFIG = {
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    startTime: '08:00',
    periodsPerDay: 8,
    periodDuration: 40,
    breaks: [{ afterPeriod: 3, minutes: 20, label: 'Short Break' }, { afterPeriod: 6, minutes: 30, label: 'Long Break' }],
    subjectPlan: {},
    maxPeriodsPerSubjectPerDay: 2,
};

// ─── time helpers ────────────────────────────────────────────────────────────
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const overlaps = (aS, aE, bS, bE) => toMin(aS) < toMin(bE) && toMin(bS) < toMin(aE);

const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
};

/** Most specific config wins: CLASS > SECTION > SCHOOL > built-in default. */
const resolveConfig = (configs, cls) => {
    const pick = (scope, id) => configs.find(c => c.scope === scope && (scope === 'SCHOOL' || c.scopeId === id));
    const found = pick('CLASS', cls.id) || (cls.sectionId && pick('SECTION', cls.sectionId)) || pick('SCHOOL');
    if (!found) return { ...DEFAULT_CONFIG };
    return {
        days: found.days?.length ? found.days : DEFAULT_CONFIG.days,
        startTime: found.startTime || DEFAULT_CONFIG.startTime,
        periodsPerDay: found.periodsPerDay || DEFAULT_CONFIG.periodsPerDay,
        periodDuration: found.periodDuration || DEFAULT_CONFIG.periodDuration,
        breaks: Array.isArray(found.breaks) ? found.breaks : [],
        subjectPlan: found.subjectPlan || {},
        maxPeriodsPerSubjectPerDay: found.maxPeriodsPerSubjectPerDay || 2,
    };
};

/** Turns a config into the ordered period grid (lessons + breaks) with clock times. */
const buildLayout = (cfg) => {
    const periods = [];
    let t = toMin(cfg.startTime);
    for (let i = 1; i <= cfg.periodsPerDay; i++) {
        periods.push({ index: i, type: 'LESSON', start: toHHMM(t), end: toHHMM(t + cfg.periodDuration), label: `Period ${i}` });
        t += cfg.periodDuration;
        const br = (cfg.breaks || []).find(b => Number(b.afterPeriod) === i);
        if (br && i < cfg.periodsPerDay) {
            periods.push({ index: i, type: 'BREAK', start: toHHMM(t), end: toHHMM(t + Number(br.minutes || 15)), label: br.label || 'Break' });
            t += Number(br.minutes || 15);
        }
    }
    return { days: cfg.days, periods };
};

// ─── class timetable generation ──────────────────────────────────────────────
/**
 * Greedy randomised placement with retries. Subjects are split into blocks (triple / double / single periods);
 * each block needs consecutive lesson periods with no break between, a free teacher and respects the
 * per-subject-per-day cap. `teacherBusy` is shared across classes so teachers are never double-booked.
 */
const generateForClass = ({ cls, cfg, layout, subjects, teacherBusy }) => {
    const lessons = layout.periods.filter(p => p.type === 'LESSON');
    const days = cfg.days;
    const capacity = days.length * lessons.length;

    // runs of lessons not separated by a break → where multi-period blocks may sit
    const runOf = {};
    let run = 0;
    layout.periods.forEach(p => { if (p.type === 'BREAK') run++; else runOf[p.index] = run; });

    // demand
    const n = subjects.length || 1;
    const planned = subjects.map(s => ({ ...s, plan: cfg.subjectPlan?.[s.subjectId] || {} }));
    const explicit = planned.reduce((a, s) => a + (s.plan.weekly || 0), 0);
    const auto = planned.filter(s => !s.plan.weekly);
    const share = auto.length ? Math.max(1, Math.floor(Math.max(capacity - explicit, auto.length) / auto.length)) : 0;
    let leftover = auto.length ? Math.max(capacity - explicit - share * auto.length, 0) : 0;
    const items = [];
    planned.forEach((s, idx) => {
        let weekly = s.plan.weekly || share;
        if (!s.plan.weekly && leftover > 0) { weekly += 1; leftover -= 1; }
        let triples = Math.min(s.plan.triple || 0, Math.floor(weekly / 3));
        weekly -= triples * 3;
        let doubles = Math.min(s.plan.double || 0, Math.floor(weekly / 2));
        weekly -= doubles * 2;
        const color = COLORS[idx % COLORS.length];
        for (let i = 0; i < triples; i++) items.push({ ...s, size: 3, color });
        for (let i = 0; i < doubles; i++) items.push({ ...s, size: 2, color });
        for (let i = 0; i < weekly; i++) items.push({ ...s, size: 1, color });
    });
    void n;

    let best = { placed: [], unplaced: items.length };
    for (let attempt = 0; attempt < 40; attempt++) {
        // free the best attempt's teacher bookings so it can't block the new attempt for this same class
        if (best.tmp) best.tmp.forEach(([t, d, s, e]) => teacherBusy.release(t, d, s, e));
        const grid = {}; // `${day}|${period}` → true
        const placed = [];
        const perDay = {}; // subjectId|day → count
        const tmpBusy = []; // teacher bookings made during this attempt (rolled back if attempt is discarded)
        let unplaced = 0;

        const ordered = shuffle(items).sort((a, b) => b.size - a.size);
        for (const item of ordered) {
            const maxDay = Math.max(cfg.maxPeriodsPerSubjectPerDay || 2, item.size);
            const cands = [];
            for (const day of shuffle(days)) {
                const dayCount = perDay[`${item.subjectId}|${day}`] || 0;
                if (dayCount > 0 && dayCount + item.size > maxDay) continue;
                for (let i = 0; i + item.size <= lessons.length; i++) {
                    const block = lessons.slice(i, i + item.size);
                    if (block.some(p => runOf[p.index] !== runOf[block[0].index])) continue;
                    if (block.some(p => grid[`${day}|${p.index}`])) continue;
                    if (item.teacherId && block.some(p => teacherBusy.isBusy(item.teacherId, day, p.start, p.end))) continue;
                    cands.push({ day, block, score: dayCount * 10 + Math.random() });
                }
            }
            if (!cands.length) { unplaced += 1; continue; }
            cands.sort((a, b) => a.score - b.score);
            const { day, block } = cands[0];
            const blockId = item.size > 1 ? `${cls.id}-${day}-${block[0].index}-${item.subjectId}` : null;
            block.forEach(p => {
                grid[`${day}|${p.index}`] = true;
                if (item.teacherId) { teacherBusy.book(item.teacherId, day, p.start, p.end); tmpBusy.push([item.teacherId, day, p.start, p.end]); }
                placed.push({
                    classId: cls.id, day, period: p.index, slotType: 'LESSON', startTime: p.start, endTime: p.end,
                    subjectId: item.subjectId, title: item.name, teacherId: item.teacherId || null, teacherName: item.teacherName || null,
                    blockId, color: item.color,
                });
            });
            perDay[`${item.subjectId}|${day}`] = (perDay[`${item.subjectId}|${day}`] || 0) + item.size;
        }

        if (attempt === 0 || unplaced < best.unplaced) {
            best = { placed, unplaced, tmp: tmpBusy };
            if (unplaced === 0) break;
        } else {
            tmpBusy.forEach(([t, d, s, e]) => teacherBusy.release(t, d, s, e));
            best.tmp.forEach(([t, d, s, e]) => teacherBusy.book(t, d, s, e));
        }
    }
    return { slots: best.placed, unplaced: best.unplaced, capacity, demand: items.reduce((a, i) => a + i.size, 0) };
};

/** Tracks when each teacher is busy (day + minute ranges), across every class being generated. */
const createTeacherBusy = (existingSlots = []) => {
    const map = new Map(); // `${teacherId}|${day}` → [[s,e]...]
    const key = (t, d) => `${t}|${d}`;
    const api = {
        isBusy: (t, d, s, e) => (map.get(key(t, d)) || []).some(([bs, be]) => toMin(s) < be && bs < toMin(e)),
        book: (t, d, s, e) => { const k = key(t, d); map.set(k, [...(map.get(k) || []), [toMin(s), toMin(e)]]); },
        release: (t, d, s, e) => {
            const k = key(t, d); const arr = map.get(k) || [];
            const i = arr.findIndex(([bs, be]) => bs === toMin(s) && be === toMin(e));
            if (i >= 0) arr.splice(i, 1);
        },
    };
    existingSlots.forEach(s => s.teacherId && s.day && api.book(s.teacherId, s.day, s.startTime, s.endTime));
    return api;
};

/** Loads every class's subjects + teachers for generation. */
const loadClassCurriculum = async (schoolId, classIds) => {
    const rows = await prisma.classSubject.findMany({
        where: { classId: { in: classIds } },
        include: { subject: true, teacher: { include: { user: { select: { name: true } } } } },
    });
    const byClass = {};
    rows.forEach(r => {
        if (r.subject?.isDeleted) return;
        let teacherId = r.teacherId, teacherName = r.teacher?.user?.name;
        (byClass[r.classId] ||= []).push({ subjectId: r.subjectId, name: r.subject.name, type: r.subject.type, teacherId, teacherName, _fallback: r.subject.teacherId });
    });
    // fall back to the subject's own teacher when the class-subject has none
    const needTeachers = [...new Set(Object.values(byClass).flat().filter(s => !s.teacherId && s._fallback).map(s => s._fallback))];
    if (needTeachers.length) {
        const ts = await prisma.teacherProfile.findMany({ where: { id: { in: needTeachers }, schoolId }, include: { user: { select: { name: true } } } });
        const tm = new Map(ts.map(t => [t.id, t.user.name]));
        Object.values(byClass).flat().forEach(s => { if (!s.teacherId && s._fallback) { s.teacherId = s._fallback; s.teacherName = tm.get(s._fallback) || null; } });
    }
    // core subjects first so leftovers go to them
    Object.values(byClass).forEach(list => list.sort((a, b) => (/core|compuls/i.test(b.type || '') ? 1 : 0) - (/core|compuls/i.test(a.type || '') ? 1 : 0)));
    return byClass;
};

// ─── exam / activity auto scheduling ─────────────────────────────────────────
/** One paper per class per session; spreads papers over the dates, one per day first. */
const generateExamSlots = ({ classes, curriculum, dates, sessions, kind = 'EXAM' }) => {
    const slots = [];
    const warnings = [];
    const sessionList = sessions.length ? sessions : [{ start: '09:00', end: '11:00' }];
    const cells = [];
    // day-major → one paper a day until dates run out, then second sessions
    sessionList.forEach((s, si) => dates.forEach(d => cells.push({ date: d, ...s, si })));
    cells.sort((a, b) => a.si - b.si || a.date.localeCompare(b.date));

    classes.forEach((cls, ci) => {
        const subjects = curriculum[cls.id] || [];
        if (!subjects.length) { warnings.push(`${cls.name}: no subjects assigned — nothing to schedule`); return; }
        if (subjects.length > cells.length) warnings.push(`${cls.name}: ${subjects.length - cells.length} paper(s) could not be placed (extend the date range or add sessions)`);
        subjects.slice(0, cells.length).forEach((s, i) => {
            const c = cells[i];
            slots.push({
                classId: cls.id, date: c.date, slotType: kind, startTime: c.start, endTime: c.end,
                subjectId: s.subjectId, title: s.name, teacherId: null, teacherName: null, color: COLORS[(ci + i) % COLORS.length],
            });
        });
    });
    return { slots, warnings };
};

// ─── clash detection ─────────────────────────────────────────────────────────
/**
 * `slots` – everything to check (this timetable). `others` – slots from other timetables of the same
 * session/term so teachers aren't double-booked across timetables. `classMeta` maps classId → {name, sectionName}.
 */
const detectClashes = (slots, classMeta = {}, others = []) => {
    const clashes = [];
    const name = (id) => classMeta[id]?.name || 'Unknown class';
    const section = (id) => classMeta[id]?.sectionName || null;
    const when = (s) => (s.day ? s.day : s.date ? new Date(s.date).toISOString().slice(0, 10) : '') + ` ${s.startTime}-${s.endTime}`;
    const sameDay = (a, b) => (a.day && b.day ? a.day === b.day : a.date && b.date ? new Date(a.date).getTime() === new Date(b.date).getTime() : false);
    const seen = new Set();
    const push = (type, a, b, message) => {
        const k = [type, ...[a.id, b.id].sort()].join('|');
        if (seen.has(k)) return;
        seen.add(k);
        clashes.push({ type, message, slotIds: [a.id, b.id], classIds: [...new Set([a.classId, b.classId])], section: section(a.classId) || section(b.classId) });
    };

    const all = [...slots, ...others];
    const thisIds = new Set(slots.map(s => s.id));
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            const a = all[i], b = all[j];
            if (!thisIds.has(a.id) && !thisIds.has(b.id)) continue; // only report clashes that involve this timetable
            if (!sameDay(a, b) || !overlaps(a.startTime, a.endTime, b.startTime, b.endTime)) continue;
            if (a.blockId && a.blockId === b.blockId) continue;
            if (a.classId === b.classId && thisIds.has(a.id) && thisIds.has(b.id)) {
                push('CLASS', a, b, `${name(a.classId)} has "${a.title}" and "${b.title}" at the same time (${when(a)})`);
            }
            if (a.teacherId && a.teacherId === b.teacherId) {
                push('TEACHER', a, b, `${a.teacherName || 'A teacher'} is booked for ${name(a.classId)} "${a.title}" and ${name(b.classId)} "${b.title}" at the same time (${when(a)})`);
            }
            if (a.room && b.room && a.room.trim().toLowerCase() === b.room.trim().toLowerCase()) {
                push('ROOM', a, b, `Room "${a.room}" is used by ${name(a.classId)} and ${name(b.classId)} at the same time (${when(a)})`);
            }
        }
    }
    return clashes;
};

/** Slots from other non-archived timetables of the same kind/session/term (used for cross-timetable teacher clashes). */
const loadComparableSlots = async (timetable) => {
    const others = await prisma.timetable.findMany({
        where: {
            schoolId: timetable.schoolId, isDeleted: false, id: { not: timetable.id }, kind: timetable.kind,
            status: { not: 'ARCHIVED' }, sessionName: timetable.sessionName, term: timetable.term,
        },
        select: { id: true },
    });
    if (!others.length) return [];
    return prisma.timetableSlot.findMany({ where: { timetableId: { in: others.map(o => o.id) } } });
};

module.exports = {
    ALL_DAYS, COLORS, DEFAULT_CONFIG, toMin, toHHMM, overlaps,
    resolveConfig, buildLayout, generateForClass, createTeacherBusy, loadClassCurriculum,
    generateExamSlots, detectClashes, loadComparableSlots,
};
