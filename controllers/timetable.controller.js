const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const {
    ALL_DAYS, DEFAULT_CONFIG, resolveConfig, buildLayout, generateForClass, createTeacherBusy,
    loadClassCurriculum, generateExamSlots, detectClashes, loadComparableSlots,
} = require('../services/timetable-engine.service');
const { mergeAlertConfig } = require('../services/timetable-alerts.service');
const { buildExport } = require('../services/timetable-export.service');
const { invalidateCache } = require('../services/redis.service');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];
const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);
const KINDS = ['CLASS', 'EXAM', 'ACTIVITY'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─── helpers ─────────────────────────────────────────────────────────────────
const getTimetableOr404 = async (id, schoolId) => {
    const t = await prisma.timetable.findFirst({ where: { id, schoolId, isDeleted: false } });
    if (!t) throw new CustomError.NotFoundError('Timetable not found');
    return t;
};

const loadClasses = async (schoolId, where = {}) => {
    const classes = await prisma.class.findMany({
        where: { schoolId, isDeleted: false, ...where },
        select: { id: true, name: true, sectionId: true, sectionRel: { select: { name: true } } },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
    return classes.map(c => ({ id: c.id, name: c.name, sectionId: c.sectionId, sectionName: c.sectionRel?.name || null }));
};

/** Fills in a layout (from the school's timetable settings) for every class that has none yet. Not persisted. */
const withResolvedLayouts = async (timetable, classes) => {
    if (timetable.kind !== 'CLASS') return timetable;
    const configs = await prisma.timetableConfig.findMany({ where: { schoolId: timetable.schoolId } });
    const layouts = { ...(timetable.layouts || {}) };
    classes.forEach(c => { if (!layouts[c.id]) layouts[c.id] = buildLayout(resolveConfig(configs, c)); });
    return { ...timetable, layouts };
};

const classMetaMap = (classes) => Object.fromEntries(classes.map(c => [c.id, c]));

const clashesFor = async (timetable, extraOrChanged = []) => {
    const slots = await prisma.timetableSlot.findMany({ where: { timetableId: timetable.id } });
    const classes = await loadClasses(timetable.schoolId, { id: { in: [...new Set(slots.map(s => s.classId))] } });
    const others = await loadComparableSlots(timetable);
    void extraOrChanged;
    return detectClashes(slots, classMetaMap(classes), others);
};

const slotData = (b, timetable) => {
    const weekly = timetable.kind === 'CLASS';
    if (!HHMM.test(b.startTime || '') || !HHMM.test(b.endTime || '')) throw new CustomError.BadRequestError('startTime and endTime must be HH:mm');
    if (b.startTime >= b.endTime) throw new CustomError.BadRequestError('End time must be after start time');
    if (!b.title?.trim()) throw new CustomError.BadRequestError('A subject / title is required');
    if (weekly && !ALL_DAYS.includes(b.day)) throw new CustomError.BadRequestError('A valid day is required');
    if (!weekly && !b.date) throw new CustomError.BadRequestError('A date is required');
    return {
        day: weekly ? b.day : null,
        date: weekly ? null : new Date(`${String(b.date).slice(0, 10)}T00:00:00.000Z`),
        period: Number(b.period) || 0,
        slotType: weekly ? 'LESSON' : timetable.kind,
        startTime: b.startTime, endTime: b.endTime,
        subjectId: b.subjectId || null, title: b.title.trim(),
        teacherId: b.teacherId || null, teacherName: b.teacherName || null,
        room: b.room?.trim() || null, color: b.color || null, note: b.note || null, blockId: b.blockId || null,
    };
};

// ─── meta (dropdown data for forms) ──────────────────────────────────────────
const getMeta = async (req, res) => {
    const schoolId = req.user.schoolId;
    const [classes, sections, teachers, subjects, settings, sessions] = await Promise.all([
        loadClasses(schoolId),
        prisma.section.findMany({ where: { schoolId, isDeleted: false }, orderBy: { name: 'asc' } }),
        prisma.teacherProfile.findMany({ where: { schoolId, isDeleted: false, status: 'Active' }, include: { user: { select: { name: true } } } }),
        prisma.subject.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.schoolSettings.findFirst({ where: { schoolId }, select: { currentTerm: true, currentYear: true } }),
        prisma.academicSession.findMany({ where: { schoolId, isDeleted: false }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, isCurrent: true } }),
    ]);
    res.status(StatusCodes.OK).json({
        classes, sections, subjects, sessions,
        teachers: teachers.map(t => ({ id: t.id, userId: t.userId, name: t.user.name })),
        currentTerm: settings?.currentTerm || null, currentYear: settings?.currentYear || null,
    });
};

// ─── generation settings ─────────────────────────────────────────────────────
const getConfigs = async (req, res) => {
    const configs = await prisma.timetableConfig.findMany({ where: { schoolId: req.user.schoolId } });
    res.status(StatusCodes.OK).json({ configs, defaults: DEFAULT_CONFIG });
};

const saveConfig = async (req, res) => {
    const { scope, scopeId = '', days, startTime, periodsPerDay, periodDuration, breaks, subjectPlan, maxPeriodsPerSubjectPerDay } = req.body;
    if (!['SCHOOL', 'SECTION', 'CLASS'].includes(scope)) throw new CustomError.BadRequestError('scope must be SCHOOL, SECTION or CLASS');
    if (scope !== 'SCHOOL' && !scopeId) throw new CustomError.BadRequestError('scopeId is required for section / class settings');
    if (!Array.isArray(days) || !days.length || days.some(d => !ALL_DAYS.includes(d))) throw new CustomError.BadRequestError('Pick at least one valid day');
    if (!HHMM.test(startTime || '')) throw new CustomError.BadRequestError('startTime must be HH:mm');
    if (!(periodsPerDay >= 1 && periodsPerDay <= 20)) throw new CustomError.BadRequestError('periodsPerDay must be 1–20');
    if (!(periodDuration >= 10 && periodDuration <= 180)) throw new CustomError.BadRequestError('periodDuration must be 10–180 minutes');

    const data = {
        days: ALL_DAYS.filter(d => days.includes(d)), startTime, periodsPerDay: Number(periodsPerDay), periodDuration: Number(periodDuration),
        breaks: (breaks || []).map(b => ({ afterPeriod: Number(b.afterPeriod), minutes: Number(b.minutes), label: b.label || 'Break' })),
        subjectPlan: subjectPlan || {}, maxPeriodsPerSubjectPerDay: Number(maxPeriodsPerSubjectPerDay) || 2,
    };
    const schoolId = req.user.schoolId;
    const config = await prisma.timetableConfig.upsert({
        where: { schoolId_scope_scopeId: { schoolId, scope, scopeId: scope === 'SCHOOL' ? '' : scopeId } },
        update: data, create: { schoolId, scope, scopeId: scope === 'SCHOOL' ? '' : scopeId, ...data },
    });
    res.status(StatusCodes.OK).json({ msg: 'Timetable settings saved', config });
};

const deleteConfig = async (req, res) => {
    const r = await prisma.timetableConfig.deleteMany({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!r.count) throw new CustomError.NotFoundError('Settings not found');
    res.status(StatusCodes.OK).json({ msg: 'Settings removed' });
};

// ─── alert settings ──────────────────────────────────────────────────────────
const getAlertSettings = async (req, res) => {
    const s = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId }, select: { timetableAlertConfig: true } });
    res.status(StatusCodes.OK).json({ config: mergeAlertConfig(s?.timetableAlertConfig) });
};

const saveAlertSettings = async (req, res) => {
    const config = mergeAlertConfig(req.body);
    for (const a of ['teacher', 'student', 'parent']) {
        config[a].leadMinutes = [...new Set((config[a].leadMinutes || []).map(Number).filter(n => n >= 0 && n <= 24 * 60))].sort((x, y) => y - x);
    }
    const existing = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } });
    if (existing) await prisma.schoolSettings.update({ where: { id: existing.id }, data: { timetableAlertConfig: config } });
    else await prisma.schoolSettings.create({ data: { schoolId: req.user.schoolId, timetableAlertConfig: config } });
    await invalidateCache(`tenant_${req.user.schoolId}_settings`);
    res.status(StatusCodes.OK).json({ msg: 'Alert settings saved', config });
};

// ─── section heads ───────────────────────────────────────────────────────────
const getSectionHeads = async (req, res) => {
    const sections = await prisma.section.findMany({ where: { schoolId: req.user.schoolId, isDeleted: false }, orderBy: { name: 'asc' } });
    const heads = await prisma.user.findMany({ where: { id: { in: sections.map(s => s.headUserId).filter(Boolean) } }, select: { id: true, name: true } });
    const hm = new Map(heads.map(h => [h.id, h.name]));
    res.status(StatusCodes.OK).json({ sections: sections.map(s => ({ id: s.id, name: s.name, headUserId: s.headUserId, headName: hm.get(s.headUserId) || null })) });
};

const setSectionHead = async (req, res) => {
    const { headUserId } = req.body;
    const section = await prisma.section.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!section) throw new CustomError.NotFoundError('Section not found');
    if (headUserId) {
        const u = await prisma.user.findFirst({ where: { id: headUserId, schoolId: req.user.schoolId, isDeleted: false } });
        if (!u) throw new CustomError.BadRequestError('That user does not belong to this school');
    }
    await prisma.section.update({ where: { id: section.id }, data: { headUserId: headUserId || null } });
    res.status(StatusCodes.OK).json({ msg: 'Section head updated' });
};

// ─── timetable documents ─────────────────────────────────────────────────────
const listTimetables = async (req, res) => {
    const { kind, status } = req.query;
    const timetables = await prisma.timetable.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false, ...(kind && { kind }), ...(status && { status }) },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { slots: true } } },
    });
    res.status(StatusCodes.OK).json({ timetables });
};

const createTimetable = async (req, res) => {
    const { name, kind = 'CLASS', examType, sessionName, term, startDate, endDate, description } = req.body;
    if (!name?.trim()) throw new CustomError.BadRequestError('Name is required');
    if (!KINDS.includes(kind)) throw new CustomError.BadRequestError('kind must be CLASS, EXAM or ACTIVITY');
    const t = await prisma.timetable.create({
        data: {
            schoolId: req.user.schoolId, name: name.trim(), kind, examType: kind === 'EXAM' ? (examType || 'SCHOOL_EXAM') : null,
            sessionName: sessionName || null, term: term || null, description: description || null, createdById: req.user.userId,
            startDate: startDate ? new Date(startDate) : null, endDate: endDate ? new Date(endDate) : null,
        },
    });
    res.status(StatusCodes.CREATED).json({ msg: 'Timetable created', timetable: t });
};

const getTimetable = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const slots = await prisma.timetableSlot.findMany({ where: { timetableId: timetable.id }, orderBy: [{ period: 'asc' }, { startTime: 'asc' }] });
    const classes = await loadClasses(req.user.schoolId);
    const clashes = detectClashes(slots, classMetaMap(classes), await loadComparableSlots(timetable));
    res.status(StatusCodes.OK).json({ timetable: await withResolvedLayouts(timetable, classes), slots, classes, clashes });
};

const updateTimetable = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const { name, examType, sessionName, term, startDate, endDate, description, status } = req.body;

    if (status === 'PUBLISHED' && timetable.status !== 'PUBLISHED') {
        const clashes = await clashesFor(timetable);
        if (clashes.length && !req.body.force) {
            return res.status(StatusCodes.CONFLICT).json({ msg: `${clashes.length} clash(es) found. Resolve them or publish anyway.`, clashes });
        }
    }
    const t = await prisma.timetable.update({
        where: { id: timetable.id },
        data: {
            ...(name !== undefined && { name }), ...(examType !== undefined && { examType }), ...(sessionName !== undefined && { sessionName }),
            ...(term !== undefined && { term }), ...(description !== undefined && { description }), ...(status !== undefined && { status }),
            ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
            ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
        },
    });
    res.status(StatusCodes.OK).json({ msg: 'Timetable updated', timetable: t });
};

const deleteTimetable = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    await prisma.timetable.update({ where: { id: timetable.id }, data: { isDeleted: true, deletedAt: new Date(), status: 'ARCHIVED' } });
    res.status(StatusCodes.OK).json({ msg: 'Timetable deleted' });
};

const duplicateTimetable = async (req, res) => {
    const src = await getTimetableOr404(req.params.id, req.user.schoolId);
    const slots = await prisma.timetableSlot.findMany({ where: { timetableId: src.id } });
    const copy = await prisma.timetable.create({
        data: {
            schoolId: src.schoolId, name: req.body.name || `${src.name} (copy)`, kind: src.kind, examType: src.examType,
            sessionName: req.body.sessionName ?? src.sessionName, term: req.body.term ?? src.term,
            startDate: src.startDate, endDate: src.endDate, description: src.description, layouts: src.layouts, createdById: req.user.userId,
            slots: { create: slots.map(({ id, timetableId, createdAt, updatedAt, ...rest }) => rest) },
        },
    });
    res.status(StatusCodes.CREATED).json({ msg: 'Timetable duplicated', timetable: copy });
};

// ─── generation ──────────────────────────────────────────────────────────────
const generate = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const schoolId = req.user.schoolId;
    const { classIds, sectionId, replaceExisting = true } = req.body;

    let classes = await loadClasses(schoolId, {
        ...(classIds?.length ? { id: { in: classIds } } : sectionId ? { sectionId } : {}),
    });
    if (!classes.length) throw new CustomError.BadRequestError('No classes matched');

    const warnings = [];
    const slotsOut = [];

    if (timetable.kind === 'CLASS') {
        const configs = await prisma.timetableConfig.findMany({ where: { schoolId } });
        const curriculum = await loadClassCurriculum(schoolId, classes.map(c => c.id));
        // teachers already booked by classes we are NOT regenerating (same timetable) or by other timetables of this term
        const keep = replaceExisting
            ? await prisma.timetableSlot.findMany({ where: { timetableId: timetable.id, classId: { notIn: classes.map(c => c.id) } } })
            : await prisma.timetableSlot.findMany({ where: { timetableId: timetable.id } });
        const busy = createTeacherBusy([...keep, ...(await loadComparableSlots(timetable))]);
        const layouts = { ...(timetable.layouts || {}) };

        for (const cls of classes) {
            const subjects = curriculum[cls.id] || [];
            if (!subjects.length) { warnings.push(`${cls.name}: no subjects assigned to this class — skipped`); continue; }
            const cfg = resolveConfig(configs, cls);
            const layout = buildLayout(cfg);
            layouts[cls.id] = layout;
            const r = generateForClass({ cls, cfg, layout, subjects, teacherBusy: busy });
            slotsOut.push(...r.slots);
            if (r.unplaced) warnings.push(`${cls.name}: ${r.unplaced} period(s) could not be placed (teachers too busy or not enough periods)`);
            if (r.demand > r.capacity) warnings.push(`${cls.name}: subjects need ${r.demand} periods but only ${r.capacity} exist per week`);
            if (subjects.some(s => !s.teacherId)) warnings.push(`${cls.name}: some subjects have no teacher assigned (clash checks skip them)`);
        }
        await prisma.timetable.update({ where: { id: timetable.id }, data: { layouts } });
    } else {
        const { startDate, endDate, weekdays, sessions } = req.body;
        const from = new Date(startDate || timetable.startDate), to = new Date(endDate || timetable.endDate);
        if (isNaN(from) || isNaN(to) || to < from) throw new CustomError.BadRequestError('A valid start and end date are required');
        const wanted = new Set((weekdays?.length ? weekdays : ALL_DAYS.slice(0, 5)));
        const dates = [];
        for (let d = new Date(from); d <= to && dates.length < 120; d.setUTCDate(d.getUTCDate() + 1)) {
            if (wanted.has(ALL_DAYS[(d.getUTCDay() + 6) % 7])) dates.push(d.toISOString().slice(0, 10));
        }
        if (!dates.length) throw new CustomError.BadRequestError('No exam days fall inside that date range');
        const curriculum = await loadClassCurriculum(schoolId, classes.map(c => c.id));
        const r = generateExamSlots({ classes, curriculum, dates, sessions: (sessions || []).filter(s => HHMM.test(s.start) && HHMM.test(s.end)), kind: timetable.kind });
        slotsOut.push(...r.slots.map(s => ({ ...s, date: new Date(`${s.date}T00:00:00.000Z`), day: null })));
        warnings.push(...r.warnings);
        await prisma.timetable.update({ where: { id: timetable.id }, data: { startDate: from, endDate: to } });
    }

    const ids = classes.map(c => c.id);
    await prisma.$transaction([
        ...(replaceExisting ? [prisma.timetableSlot.deleteMany({ where: { timetableId: timetable.id, classId: { in: ids } } })] : []),
        prisma.timetableSlot.createMany({ data: slotsOut.map(s => ({ ...s, schoolId, timetableId: timetable.id })) }),
    ]);

    const clashes = await clashesFor(timetable);
    res.status(StatusCodes.OK).json({ msg: `Generated ${slotsOut.length} entries for ${classes.length} class(es)`, count: slotsOut.length, warnings, clashes });
};

// ─── manual slot editing ─────────────────────────────────────────────────────
const checkCandidate = async (timetable, candidate, excludeId) => {
    const where = { timetableId: timetable.id, ...(excludeId && { id: { not: excludeId } }), ...(candidate.day ? { day: candidate.day } : { date: candidate.date }) };
    const existing = await prisma.timetableSlot.findMany({ where });
    const classes = await loadClasses(timetable.schoolId, { id: { in: [...new Set([...existing.map(s => s.classId), candidate.classId])] } });
    const others = (await loadComparableSlots(timetable)).filter(o => (candidate.day ? o.day === candidate.day : o.date && new Date(o.date).getTime() === candidate.date.getTime()));
    const probe = { ...candidate, id: '__new__' };
    return detectClashes([...existing, probe], classMetaMap(classes), others).filter(c => c.slotIds.includes('__new__'));
};

const createSlots = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const { classId, classIds, force } = req.body;
    const targets = classIds?.length ? classIds : classId ? [classId] : [];
    if (!targets.length) throw new CustomError.BadRequestError('Pick at least one class');
    if (timetable.kind !== 'CLASS' && !classIds && !classId) throw new CustomError.BadRequestError('Pick at least one class');

    const base = slotData(req.body, timetable);
    if (timetable.kind === 'CLASS') {
        // freeze the layout the first time a class is edited by hand so later settings changes don't shift saved times
        const missing = targets.filter(cid => !timetable.layouts?.[cid]);
        if (missing.length) {
            const cls = await loadClasses(req.user.schoolId, { id: { in: missing } });
            const resolved = await withResolvedLayouts(timetable, cls);
            await prisma.timetable.update({ where: { id: timetable.id }, data: { layouts: resolved.layouts } });
        }
    }
    // a double/triple period: `span` consecutive lessons starting at startTime are created as one block
    const found = await prisma.class.findMany({ where: { id: { in: targets }, schoolId: req.user.schoolId } });
    if (found.length !== targets.length) throw new CustomError.BadRequestError('One or more classes are invalid');

    const clashes = [];
    for (const cid of targets) clashes.push(...(await checkCandidate(timetable, { ...base, classId: cid }, null)));
    if (clashes.length && !force) return res.status(StatusCodes.CONFLICT).json({ msg: 'This entry clashes with existing ones', clashes });

    await prisma.timetableSlot.createMany({ data: targets.map(cid => ({ ...base, classId: cid, schoolId: req.user.schoolId, timetableId: timetable.id })) });
    res.status(StatusCodes.CREATED).json({ msg: 'Entry added', clashes });
};

const updateSlot = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const slot = await prisma.timetableSlot.findFirst({ where: { id: req.params.slotId, timetableId: timetable.id } });
    if (!slot) throw new CustomError.NotFoundError('Entry not found');
    const base = slotData({ ...slot, date: slot.date?.toISOString(), ...req.body }, timetable);
    const clashes = await checkCandidate(timetable, { ...base, classId: slot.classId }, slot.id);
    if (clashes.length && !req.body.force) return res.status(StatusCodes.CONFLICT).json({ msg: 'This change clashes with existing entries', clashes });
    const updated = await prisma.timetableSlot.update({ where: { id: slot.id }, data: base });
    res.status(StatusCodes.OK).json({ msg: 'Entry updated', slot: updated, clashes });
};

const deleteSlot = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const r = await prisma.timetableSlot.deleteMany({ where: { id: req.params.slotId, timetableId: timetable.id } });
    if (!r.count) throw new CustomError.NotFoundError('Entry not found');
    res.status(StatusCodes.OK).json({ msg: 'Entry removed' });
};

const clearClass = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const r = await prisma.timetableSlot.deleteMany({ where: { timetableId: timetable.id, classId: req.params.classId } });
    res.status(StatusCodes.OK).json({ msg: `Removed ${r.count} entries` });
};

const getClashes = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const clashes = await clashesFor(timetable);
    res.status(StatusCodes.OK).json({ clashes, count: clashes.length });
};

// ─── export (admin) ──────────────────────────────────────────────────────────
const exportTimetable = async (req, res) => {
    const timetable = await getTimetableOr404(req.params.id, req.user.schoolId);
    const { format = 'xlsx', classId, sectionId } = req.query;
    if (!['xlsx', 'pdf'].includes(format)) throw new CustomError.BadRequestError('format must be xlsx or pdf');

    const allClasses = await loadClasses(req.user.schoolId);
    let classes = allClasses;
    let scopeName = 'Whole School';
    if (classId) { classes = allClasses.filter(c => c.id === classId); scopeName = classes[0]?.name || 'Class'; }
    else if (sectionId) { classes = allClasses.filter(c => c.sectionId === sectionId); scopeName = classes[0]?.sectionName || 'Section'; }
    if (!classes.length) throw new CustomError.BadRequestError('Nothing to export for that selection');

    const slots = await prisma.timetableSlot.findMany({ where: { timetableId: timetable.id, classId: { in: classes.map(c => c.id) } }, orderBy: [{ period: 'asc' }, { startTime: 'asc' }] });
    const settings = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId }, select: { schoolName: true } });
    const resolved = await withResolvedLayouts(timetable, classes);
    const { buffer, contentType, extension } = await buildExport({ format, timetable: resolved, slots, classes, schoolName: settings?.schoolName || 'School', scopeName });

    const safe = `${timetable.name}_${scopeName}`.replace(/[^\w\- ]+/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.${extension}"`);
    res.status(StatusCodes.OK).end(buffer);
};

// ─── "my timetable": students, parents, teachers, section heads ──────────────
const getMyTimetables = async (req, res) => {
    const schoolId = req.user.schoolId;
    const userId = req.user.userId;
    const role = req.user.role;
    const views = []; // { key, label, type, classIds?, teacherId? }

    if (role === 'STUDENT') {
        const s = await prisma.studentProfile.findFirst({ where: { userId, schoolId, isDeleted: false }, include: { classArm: { select: { id: true, name: true } } } });
        if (s?.classArm) views.push({ key: `class-${s.classArm.id}`, label: `${s.classArm.name} timetable`, type: 'class', classIds: [s.classArm.id] });
    } else if (role === 'PARENT') {
        const p = await prisma.parentProfile.findFirst({
            where: { userId, schoolId, isDeleted: false },
            include: { students: { where: { isDeleted: false }, include: { user: { select: { name: true } }, classArm: { select: { id: true, name: true } } } } },
        });
        (p?.students || []).forEach(s => { if (s.classArm) views.push({ key: `child-${s.id}`, label: `${s.user.name} · ${s.classArm.name}`, type: 'class', classIds: [s.classArm.id] }); });
    } else if (role === 'TEACHER') {
        const t = await prisma.teacherProfile.findFirst({ where: { userId, schoolId, isDeleted: false } });
        if (t) views.push({ key: 'teaching', label: 'My teaching timetable', type: 'teacher', teacherId: t.id });
    }

    // anyone who heads a section sees that section's timetables
    const headed = await prisma.section.findMany({ where: { schoolId, headUserId: userId, isDeleted: false }, include: { classes: { where: { isDeleted: false }, select: { id: true } } } });
    headed.forEach(sec => views.push({ key: `section-${sec.id}`, label: `${sec.name} section`, type: 'section', classIds: sec.classes.map(c => c.id) }));

    const timetables = await prisma.timetable.findMany({ where: { schoolId, isDeleted: false, status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' } });
    const result = [];
    for (const v of views) {
        const slots = timetables.length ? await prisma.timetableSlot.findMany({
            where: { timetableId: { in: timetables.map(t => t.id) }, ...(v.type === 'teacher' ? { teacherId: v.teacherId } : { classId: { in: v.classIds } }) },
            orderBy: [{ period: 'asc' }, { startTime: 'asc' }],
        }) : [];
        const classIds = [...new Set(slots.map(s => s.classId).concat(v.classIds || []))];
        const classes = await loadClasses(schoolId, { id: { in: classIds } });
        const cm = classMetaMap(classes);
        result.push({
            ...v,
            classes,
            timetables: timetables
                .map(t => ({
                    id: t.id, name: t.name, kind: t.kind, examType: t.examType, term: t.term, sessionName: t.sessionName, layouts: t.layouts,
                    slots: slots.filter(s => s.timetableId === t.id).map(s => ({ ...s, className: cm[s.classId]?.name })),
                }))
                .filter(t => t.slots.length || (v.type !== 'teacher')),
        });
    }
    res.status(StatusCodes.OK).json({ views: result, isAdmin: isAdmin(req) });
};

// ─── reminders ───────────────────────────────────────────────────────────────
const CHANNELS = ['NOTIFICATION', 'EMAIL', 'WHATSAPP'];

const listReminders = async (req, res) => {
    const where = { schoolId: req.user.schoolId, status: { not: 'CANCELLED' } };
    if (!(isAdmin(req) && req.query.all === '1')) where.userId = req.user.userId;
    const reminders = await prisma.timetableReminder.findMany({ where, orderBy: { remindAt: 'asc' }, take: 300 });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(reminders.map(r => r.userId))] } }, select: { id: true, name: true, role: true } });
    const um = new Map(users.map(u => [u.id, u]));
    res.status(StatusCodes.OK).json({ reminders: reminders.map(r => ({ ...r, userName: um.get(r.userId)?.name, userRole: um.get(r.userId)?.role })) });
};

const createReminder = async (req, res) => {
    const { title, note, remindAt, channels, userIds, group } = req.body;
    if (!title?.trim()) throw new CustomError.BadRequestError('A title is required');
    const when = new Date(remindAt);
    if (isNaN(when.getTime())) throw new CustomError.BadRequestError('A valid reminder date and time is required');
    if (when.getTime() < Date.now() - 60 * 1000) throw new CustomError.BadRequestError('The reminder time is in the past');
    const ch = (channels || ['NOTIFICATION']).filter(c => CHANNELS.includes(c));
    if (!ch.length) throw new CustomError.BadRequestError('Pick at least one channel');

    const schoolId = req.user.schoolId;
    let targets = [req.user.userId];
    if (userIds?.length || group) {
        if (!isAdmin(req)) throw new CustomError.UnauthorizedError('Only admins can set reminders for other users');
        if (group) {
            const roleMap = { TEACHERS: ['TEACHER'], STUDENTS: ['STUDENT'], PARENTS: ['PARENT'], ALL: ['TEACHER', 'STUDENT', 'PARENT'] };
            if (!roleMap[group]) throw new CustomError.BadRequestError('Unknown group');
            const us = await prisma.user.findMany({ where: { schoolId, isDeleted: false, role: { in: roleMap[group] } }, select: { id: true } });
            targets = us.map(u => u.id);
        } else {
            const us = await prisma.user.findMany({ where: { schoolId, isDeleted: false, id: { in: userIds } }, select: { id: true } });
            targets = us.map(u => u.id);
        }
        if (!targets.length) throw new CustomError.BadRequestError('No matching users');
    }

    await prisma.timetableReminder.createMany({
        data: targets.map(uid => ({
            schoolId, userId: uid, createdById: req.user.userId, createdByAdmin: uid !== req.user.userId,
            title: title.trim(), note: note || null, remindAt: when, channels: ch,
        })),
    });
    res.status(StatusCodes.CREATED).json({ msg: `Reminder set for ${targets.length} user${targets.length === 1 ? '' : 's'}`, count: targets.length });
};

const deleteReminder = async (req, res) => {
    const r = await prisma.timetableReminder.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!r) throw new CustomError.NotFoundError('Reminder not found');
    if (r.userId !== req.user.userId && !isAdmin(req)) throw new CustomError.UnauthorizedError('Not your reminder');
    await prisma.timetableReminder.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
    res.status(StatusCodes.OK).json({ msg: 'Reminder cancelled' });
};

const searchReminderTargets = async (req, res) => {
    const q = String(req.query.q || '').trim();
    const users = await prisma.user.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false, role: { in: ['TEACHER', 'STUDENT', 'PARENT'] }, ...(q && { name: { contains: q, mode: 'insensitive' } }) },
        select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: 25,
    });
    res.status(StatusCodes.OK).json({ users });
};

module.exports = {
    getMeta, getConfigs, saveConfig, deleteConfig, getAlertSettings, saveAlertSettings, getSectionHeads, setSectionHead,
    listTimetables, createTimetable, getTimetable, updateTimetable, deleteTimetable, duplicateTimetable,
    generate, createSlots, updateSlot, deleteSlot, clearClass, getClashes, exportTimetable,
    getMyTimetables, listReminders, createReminder, deleteReminder, searchReminderTargets,
};
