const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { invalidateCache } = require('../services/redis.service');
const store = require('../services/academic-storage.service');
const content = require('../services/cbt-content.service');
const parser = require('../services/cbt-parser.service');
const cbtAi = require('../services/cbt-ai.service');
const { CURRICULA } = require('../services/academic-ai.service');
const { logExamEvent } = require('../services/cbt-attempt.service');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];
const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);

const loadConfig = async (schoolId) => {
    const s = await prisma.schoolSettings.findFirst({ where: { schoolId }, select: { cbtConfig: true } });
    return content.mergeConfig(s?.cbtConfig);
};

const getTeacher = async (req) => {
    if (req._teacher !== undefined) return req._teacher;
    req._teacher = await prisma.teacherProfile.findUnique({ where: { userId: req.user.userId }, select: { id: true } });
    return req._teacher;
};

/** The (class, subject) pairs a teacher is allowed to set exams for. Admins get every pair. */
const loadAssignments = async (req) => {
    const where = { class: { schoolId: req.user.schoolId, isDeleted: false }, subject: { isDeleted: false } };
    if (!isAdmin(req)) {
        const t = await getTeacher(req);
        if (!t) return [];
        where.teacherId = t.id;
    }
    const rows = await prisma.classSubject.findMany({
        where, select: { classId: true, subjectId: true, class: { select: { name: true, order: true } }, subject: { select: { name: true } } },
        orderBy: [{ class: { order: 'asc' } }, { class: { name: 'asc' } }],
    });
    return rows.map(r => ({ classId: r.classId, className: r.class.name, subjectId: r.subjectId, subjectName: r.subject.name }));
};

const assertCanManage = async (req, classId, subjectId) => {
    if (isAdmin(req)) return;
    const t = await getTeacher(req);
    const ok = t && await prisma.classSubject.findFirst({ where: { classId, subjectId, teacherId: t.id } });
    if (!ok) throw new CustomError.UnauthorizedError('You are not assigned to this class and subject');
};

const bank = (e, fallback) => { if (e instanceof content.QuestionError) throw new CustomError.BadRequestError(e.message); if (e.status === 413) throw new CustomError.BadRequestError(e.message); throw fallback || e; };

// ─── meta / settings ─────────────────────────────────────────────────────────
const getMeta = async (req, res) => {
    const schoolId = req.user.schoolId;
    const [cfg, assignments, subjects, sessions, settings, storage, used] = await Promise.all([
        loadConfig(schoolId), loadAssignments(req),
        prisma.subject.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.academicSession.findMany({ where: { schoolId, isDeleted: false }, select: { name: true, isCurrent: true }, orderBy: { createdAt: 'desc' } }),
        prisma.schoolSettings.findFirst({ where: { schoolId }, select: { currentTerm: true, currentYear: true } }),
        store.getStorage(schoolId), cbtAi.getUsage(req.user.userId),
    ]);
    const admin = isAdmin(req);
    const mySubjectIds = new Set(assignments.map(a => a.subjectId));
    const classes = [...new Map(assignments.map(a => [a.classId, { id: a.classId, name: a.className }])).values()];
    res.status(StatusCodes.OK).json({
        config: cfg, assignments, classes, subjects: admin ? subjects : subjects.filter(s => mySubjectIds.has(s.id)), sessions, storage,
        currentTerm: settings?.currentTerm || null, currentYear: settings?.currentYear || null, curricula: CURRICULA,
        ai: { configured: !!process.env.GEMINI_API_KEY, enabled: admin || cfg.teacherAiEnabled, usedToday: used, dailyLimit: admin ? null : cfg.teacherDailyAiLimit },
        canUpload: admin || cfg.teacherCanUpload, isAdmin: admin,
        can: { editTimer: admin || cfg.teacherCanEditTimer, addTime: admin || cfg.teacherCanAddTime, exempt: admin || cfg.teacherCanExempt, markEssays: admin || cfg.teacherCanMarkEssays, releaseResults: admin },
    });
};

const saveConfig = async (req, res) => {
    const cfg = content.cleanConfig(req.body || {});
    const existing = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } });
    if (existing) await prisma.schoolSettings.update({ where: { id: existing.id }, data: { cbtConfig: cfg } });
    else await prisma.schoolSettings.create({ data: { schoolId: req.user.schoolId, cbtConfig: cfg } });
    await invalidateCache(`tenant_${req.user.schoolId}_settings`);
    res.status(StatusCodes.OK).json({ msg: 'CBT settings saved', config: cfg });
};

// ─── question bank ───────────────────────────────────────────────────────────
const questionScope = (req) => ({ schoolId: req.user.schoolId, isDeleted: false, ...(isAdmin(req) ? {} : { ownerUserId: req.user.userId }) });

const assertSubjectAllowed = async (req, subjectId) => {
    if (!subjectId) throw new CustomError.BadRequestError('Choose a subject');
    const subject = await prisma.subject.findFirst({ where: { id: subjectId, schoolId: req.user.schoolId, isDeleted: false }, select: { id: true } });
    if (!subject) throw new CustomError.NotFoundError('Subject not found');
    if (!isAdmin(req)) {
        const t = await getTeacher(req);
        const ok = t && await prisma.classSubject.findFirst({ where: { subjectId, teacherId: t.id } });
        if (!ok) throw new CustomError.UnauthorizedError('You are not assigned to this subject');
    }
};

const listQuestions = async (req, res) => {
    const { subjectId, classId, type, difficulty, topic, q, source, scope } = req.query;
    const ids = req.query.ids ? String(req.query.ids).split(',').filter(Boolean).slice(0, 300) : null; // fetch specific questions (e.g. just imported)
    const page = ids ? 1 : Math.max(1, Number(req.query.page) || 1);
    const take = ids ? ids.length || 1 : Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const where = {
        ...questionScope(req),
        ...(ids && { id: { in: ids } }),
        ...(isAdmin(req) && scope === 'mine' && { ownerUserId: req.user.userId }),
        ...(subjectId && { subjectId }), ...(classId && { classId }), ...(type && { type }), ...(difficulty && { difficulty }), ...(source && { source }),
        ...(topic && { topic: { contains: String(topic), mode: 'insensitive' } }),
        ...(q && { OR: [{ questionText: { contains: String(q), mode: 'insensitive' } }, { topic: { contains: String(q), mode: 'insensitive' } }] }),
    };
    const [total, questions, topics] = await Promise.all([
        prisma.questionBank.count({ where }),
        prisma.questionBank.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take, include: { subject: { select: { name: true } }, _count: { select: { examQuestions: true } } } }),
        prisma.questionBank.findMany({ where: { ...questionScope(req), ...(subjectId && { subjectId }), topic: { not: null } }, select: { topic: true }, distinct: ['topic'], take: 200 }),
    ]);
    res.status(StatusCodes.OK).json({ total, page, pages: Math.ceil(total / take), questions, topics: topics.map(t => t.topic).sort() });
};

const saveOne = async (req, data, subjectId, extra = {}) => {
    const owner = extra.owner || await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const t = await getTeacher(req);
    return {
        schoolId: req.user.schoolId, subjectId, teacherId: t?.id || null, ownerUserId: req.user.userId, ownerName: owner?.name || null,
        classId: extra.classId || null, source: extra.source || 'MANUAL', ...data,
    };
};

const createQuestion = async (req, res) => {
    const b = req.body || {};
    await assertSubjectAllowed(req, b.subjectId);
    let data;
    try { data = content.normalizeQuestion(b); await store.assertCapacity(req.user.schoolId, data.sizeBytes); } catch (e) { bank(e); }
    const question = await prisma.questionBank.create({ data: await saveOne(req, data, b.subjectId, { classId: b.classId, source: ['AI', 'IMPORT'].includes(b.source) ? b.source : 'MANUAL' }) });
    res.status(StatusCodes.CREATED).json({ msg: 'Question saved to the bank', question });
};

/** Saves many drafts at once (paste / Excel / Word / PDF / AI). Invalid drafts are returned, valid ones saved. */
const bulkCreateQuestions = async (req, res) => {
    const { subjectId, classId, questions, source } = req.body || {};
    await assertSubjectAllowed(req, subjectId);
    if (!Array.isArray(questions) || !questions.length) throw new CustomError.BadRequestError('There are no questions to save');
    if (questions.length > 300) throw new CustomError.BadRequestError('Save at most 300 questions at a time');

    const ok = []; const errors = [];
    questions.forEach((q, i) => {
        try { ok.push(content.normalizeQuestion(q)); } catch (e) { errors.push({ index: i, number: q.number ?? i + 1, error: e.message }); }
    });
    if (!ok.length) return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'None of the questions could be saved', errors });
    try { await store.assertCapacity(req.user.schoolId, ok.reduce((n, q) => n + q.sizeBytes, 0)); } catch (e) { bank(e); }

    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const rows = await Promise.all(ok.map(async q => saveOne(req, q, subjectId, { classId, source: ['AI', 'IMPORT'].includes(source) ? source : 'MANUAL', owner })));
    const created = await prisma.$transaction(rows.map(data => prisma.questionBank.create({ data })));
    res.status(StatusCodes.CREATED).json({ msg: `${created.length} question${created.length === 1 ? '' : 's'} saved`, saved: created.length, ids: created.map(c => c.id), errors });
};

const findQuestion = async (req, id) => {
    const q = await prisma.questionBank.findFirst({ where: { id, ...questionScope(req) } });
    if (!q) throw new CustomError.NotFoundError('Question not found');
    return q;
};

const updateQuestion = async (req, res) => {
    const existing = await findQuestion(req, req.params.id);
    const taken = await prisma.cBTResult.count({ where: { exam: { examQuestions: { some: { questionId: existing.id } } } } });
    if (taken) throw new CustomError.BadRequestError('This question is in an exam that students have already started. Duplicate it and edit the copy instead.');
    const b = { ...req.body, subjectId: req.body.subjectId || existing.subjectId };
    await assertSubjectAllowed(req, b.subjectId);
    let data;
    try { data = content.normalizeQuestion(b); await store.assertCapacity(req.user.schoolId, data.sizeBytes, existing.sizeBytes); } catch (e) { bank(e); }
    const question = await prisma.questionBank.update({ where: { id: existing.id }, data: { ...data, subjectId: b.subjectId, classId: b.classId ?? existing.classId } });
    res.status(StatusCodes.OK).json({ msg: 'Question updated', question });
};

const deleteQuestions = async (req, res) => {
    const ids = req.params.id ? [req.params.id] : (Array.isArray(req.body?.ids) ? req.body.ids : []);
    if (!ids.length) throw new CustomError.BadRequestError('Nothing selected');
    const found = await prisma.questionBank.findMany({ where: { id: { in: ids }, ...questionScope(req) }, select: { id: true } });
    await prisma.questionBank.updateMany({ where: { id: { in: found.map(f => f.id) } }, data: { isDeleted: true } });
    res.status(StatusCodes.OK).json({ msg: `${found.length} question${found.length === 1 ? '' : 's'} removed from the bank`, deleted: found.length });
};

// ─── import: paste / Excel / Word / PDF ──────────────────────────────────────
const IMPORT_EXT = { xlsx: 'sheet', xls: 'sheet', csv: 'sheet', docx: 'docx', pdf: 'pdf' };

const assertUploadAllowed = (req, cfg) => {
    if (!isAdmin(req) && !cfg.teacherCanUpload) throw new CustomError.UnauthorizedError('Uploads are turned off for teachers in the CBT settings');
};

const assertAiAllowed = async (req, cfg) => {
    if (isAdmin(req)) return;
    if (!cfg.teacherAiEnabled) throw new CustomError.UnauthorizedError('AI is turned off for teachers in the CBT settings');
    if ((await cbtAi.getUsage(req.user.userId)) >= cfg.teacherDailyAiLimit) throw new CustomError.BadRequestError(`You have reached today's limit of ${cfg.teacherDailyAiLimit} AI requests. Try again tomorrow or add questions manually.`);
};

const aiFail = (res, e) => {
    if (e.status === 400 || e.status === 422) throw new CustomError.BadRequestError(e.message);
    console.error('[cbt-ai] failed:', e.message);
    return res.status(e.status || 502).json({ msg: e.message });
};

const draftsFromText = async (req, cfg, text, { useAI, images }) => {
    let drafts = parser.parseQuestionText(text, { images });
    const weak = !drafts.length || drafts.filter(d => d.warnings.length).length > drafts.length / 2;
    let usedAi = false;
    if (useAI || (weak && text.trim().length > 40 && (isAdmin(req) || cfg.teacherAiEnabled))) {
        if (useAI) await assertAiAllowed(req, cfg);
        try {
            const r = await cbtAi.structureText(text, cfg);
            if (r.drafts.length >= drafts.length || useAI) { drafts = r.drafts; usedAi = true; await cbtAi.bumpUsage(req.user.userId); }
        } catch (e) { if (useAI) throw e; /* silent fallback to the rule-based result */ }
    }
    return { drafts, usedAi };
};

const parseText = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const text = String(req.body?.text || '');
    if (!text.trim()) throw new CustomError.BadRequestError('Paste some questions first');
    if (text.length > 200000) throw new CustomError.BadRequestError('That is too much text at once. Paste fewer questions.');
    try {
        const { drafts, usedAi } = await draftsFromText(req, cfg, text, { useAI: !!req.body?.useAI });
        res.status(StatusCodes.OK).json({ drafts, usedAi, count: drafts.length });
    } catch (e) { aiFail(res, e); }
};

const importFile = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    assertUploadAllowed(req, cfg);
    const file = req.files?.file;
    if (!file) throw new CustomError.BadRequestError('Choose an Excel, Word or PDF file');
    const kind = IMPORT_EXT[String(file.name).split('.').pop().toLowerCase()];
    if (!kind) throw new CustomError.BadRequestError('Only Excel (.xlsx, .xls, .csv), Word (.docx) and PDF files can be imported');
    if (file.size > cfg.maxUploadMB * store.MB) throw new CustomError.BadRequestError(`File is too large. The limit is ${cfg.maxUploadMB} MB.`);

    try {
        if (kind === 'sheet') {
            const drafts = parser.fromSheet(file.data);
            if (!drafts.length) throw new CustomError.BadRequestError('No questions were found in the sheet.');
            return res.status(StatusCodes.OK).json({ drafts, count: drafts.length, source: 'excel' });
        }
        const extracted = kind === 'docx' ? await parser.fromDocx(file.data) : await parser.fromPdf(file.data);
        if (!extracted.text.trim()) throw new CustomError.BadRequestError('No readable text was found in this file. If it is a scan, type or paste the questions instead.');
        const { drafts, usedAi } = await draftsFromText(req, cfg, extracted.text, { useAI: req.body?.useAI === 'true' || req.body?.useAI === true, images: extracted.images });
        if (!drafts.length) throw new CustomError.BadRequestError('No questions could be recognised in this file.');
        res.status(StatusCodes.OK).json({ drafts, count: drafts.length, usedAi, source: kind, note: extracted.note });
    } catch (e) {
        if (e instanceof CustomError.BadRequestError || e instanceof CustomError.UnauthorizedError) throw e;
        if (e.status === 400) throw new CustomError.BadRequestError(e.message);
        if (e.status) return aiFail(res, e);
        console.error('[cbt-import] failed:', e.message);
        throw new CustomError.BadRequestError('That file could not be read. Check that it is not password-protected or damaged.');
    }
};

const downloadTemplate = async (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cbt-questions-template.xlsx"');
    res.status(StatusCodes.OK).end(parser.buildTemplate());
};

// ─── AI ──────────────────────────────────────────────────────────────────────
const aiGenerate = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    await assertAiAllowed(req, cfg);
    const b = req.body || {};
    await assertSubjectAllowed(req, b.subjectId);
    const subject = await prisma.subject.findUnique({ where: { id: b.subjectId }, select: { name: true } });
    const cls = b.classId ? await prisma.class.findFirst({ where: { id: b.classId, schoolId: req.user.schoolId }, select: { name: true } }) : null;
    try {
        const out = await cbtAi.generateQuestions({ ...b, subject: subject?.name, level: cls?.name || b.level }, cfg);
        await cbtAi.bumpUsage(req.user.userId);
        res.status(StatusCodes.OK).json({ ...out, count: out.drafts.length });
    } catch (e) { aiFail(res, e); }
};

// ─── exams ───────────────────────────────────────────────────────────────────
const cleanSettings = (s, cfg) => {
    const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    s = s || {};
    return {
        warnAtMinutes: n(s.warnAtMinutes, 0, 60, cfg.warnAtMinutes),
        allowBackNav: typeof s.allowBackNav === 'boolean' ? s.allowBackNav : cfg.allowBackNav,
        disableCopyPaste: typeof s.disableCopyPaste === 'boolean' ? s.disableCopyPaste : cfg.disableCopyPaste,
    };
};

const examScope = async (req) => {
    const base = { schoolId: req.user.schoolId, isDeleted: false };
    if (isAdmin(req)) return base;
    const pairs = await loadAssignments(req);
    return { ...base, OR: [{ ownerUserId: req.user.userId }, ...pairs.map(p => ({ classId: p.classId, subjectId: p.subjectId }))] };
};

const parseDate = (v, label) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new CustomError.BadRequestError(`${label} is not a valid date`);
    return d;
};

/** Everything a teacher or admin may set on an exam, validated against the school's CBT policy. */
const examFields = async (req, b, cfg, existing) => {
    const admin = isAdmin(req);
    const classId = b.classId ?? existing?.classId, subjectId = b.subjectId ?? existing?.subjectId;
    if (!classId || !subjectId) throw new CustomError.BadRequestError('Choose a class and subject');
    if (!existing || classId !== existing.classId || subjectId !== existing.subjectId) {
        await assertCanManage(req, classId, subjectId);
        const offered = await prisma.classSubject.findFirst({ where: { classId, subjectId, class: { schoolId: req.user.schoolId } } });
        if (!offered) throw new CustomError.BadRequestError('That subject is not offered in the chosen class');
    }
    const title = (b.title ?? existing?.title ?? '').trim();
    if (!title) throw new CustomError.BadRequestError('Give the exam a title');
    const term = b.term !== undefined ? (b.term || null) : (existing?.term ?? null);
    const sessionName = b.sessionName !== undefined ? (b.sessionName || null) : (existing?.sessionName ?? null);
    if (cfg.requireTermSession && (!term || !sessionName)) throw new CustomError.BadRequestError('Pick the term and session for this exam');

    const canTimer = admin || cfg.teacherCanEditTimer;
    const duration = canTimer ? Math.round(Number(b.durationMinutes ?? existing?.durationMinutes ?? cfg.defaultDurationMinutes)) : (existing?.durationMinutes ?? cfg.defaultDurationMinutes);
    if (!(duration >= 1 && duration <= 600)) throw new CustomError.BadRequestError('Duration must be between 1 and 600 minutes');
    const passingMarks = Math.round(Number(b.passingMarks ?? existing?.passingMarks ?? cfg.defaultPassMark));
    if (!(passingMarks >= 0 && passingMarks <= 100)) throw new CustomError.BadRequestError('Pass mark must be between 0 and 100');

    const startTime = parseDate(b.startTime, 'Start time') ?? (b.startTime === undefined ? existing?.startTime ?? null : null);
    const endTime = parseDate(b.endTime, 'End time') ?? (b.endTime === undefined ? existing?.endTime ?? null : null);
    if (startTime && endTime && endTime <= startTime) throw new CustomError.BadRequestError('The exam must close after it opens');

    const data = {
        classId, subjectId, title: title.slice(0, 200), term, sessionName, durationMinutes: duration, passingMarks, startTime, endTime,
        instructions: b.instructions !== undefined ? String(b.instructions || '').slice(0, 8000) : existing?.instructions ?? null,
        shuffleQuestions: typeof b.shuffleQuestions === 'boolean' ? b.shuffleQuestions : existing?.shuffleQuestions ?? cfg.shuffleQuestions,
        shuffleOptions: typeof b.shuffleOptions === 'boolean' ? b.shuffleOptions : existing?.shuffleOptions ?? cfg.shuffleOptions,
        settings: cleanSettings({ ...(existing?.settings || {}), ...(b.settings || {}) }, cfg),
    };
    if (admin && ['INHERIT', 'HIDDEN', 'RELEASED'].includes(b.resultRelease)) data.resultRelease = b.resultRelease;
    if (['DRAFT', 'PUBLISHED', 'CONCLUDED'].includes(b.status)) data.status = b.status;
    return data;
};

const loadQuestionRows = async (req, ids, subjectId) => {
    const uniq = [...new Set(ids)];
    const rows = await prisma.questionBank.findMany({ where: { id: { in: uniq }, ...questionScope(req) } });
    if (rows.length !== uniq.length) throw new CustomError.BadRequestError('Some selected questions could not be found, or are not yours');
    if (rows.some(r => r.subjectId !== subjectId)) throw new CustomError.BadRequestError('All questions must belong to the exam’s subject');
    return uniq.map(id => rows.find(r => r.id === id));
};

const examSummaries = async (exams) => {
    if (!exams.length) return {};
    const ids = exams.map(e => e.id);
    const groups = await prisma.cBTResult.groupBy({ by: ['examId', 'status', 'markingStatus'], where: { examId: { in: ids } }, _count: { _all: true } });
    const out = {};
    for (const g of groups) {
        const s = out[g.examId] ||= { submitted: 0, inProgress: 0, locked: 0, pendingMarking: 0 };
        if (g.status === 'SUBMITTED') { s.submitted += g._count._all; if (g.markingStatus === 'PENDING') s.pendingMarking += g._count._all; }
        else if (g.status === 'IN_PROGRESS') s.inProgress += g._count._all;
        else if (g.status === 'LOCKED') s.locked += g._count._all;
    }
    return out;
};

const listExams = async (req, res) => {
    const { classId, subjectId, term, sessionName, status, q } = req.query;
    const where = {
        AND: [await examScope(req), {
            ...(classId && { classId }), ...(subjectId && { subjectId }), ...(term && { term }), ...(sessionName && { sessionName }), ...(status && { status }),
            ...(q && { title: { contains: String(q), mode: 'insensitive' } }),
        }],
    };
    const exams = await prisma.exam.findMany({
        where, orderBy: { createdAt: 'desc' }, take: 300,
        include: { subject: { select: { name: true } }, class: { select: { name: true } }, _count: { select: { examQuestions: true } } },
    });
    const sums = await examSummaries(exams);
    res.status(StatusCodes.OK).json({ exams: exams.map(e => ({ ...e, stats: sums[e.id] || { submitted: 0, inProgress: 0, locked: 0, pendingMarking: 0 } })) });
};

const findExam = async (req, id, { edit = false } = {}) => {
    const exam = await prisma.exam.findFirst({ where: { AND: [{ id }, await examScope(req)] } });
    if (!exam) throw new CustomError.NotFoundError('Exam not found');
    if (edit && !isAdmin(req) && exam.ownerUserId !== req.user.userId) throw new CustomError.UnauthorizedError('Only the teacher who created this exam (or an administrator) can change it');
    return exam;
};

const getExam = async (req, res) => {
    const exam = await findExam(req, req.params.id);
    const full = await prisma.exam.findUnique({
        where: { id: exam.id },
        include: { subject: { select: { name: true } }, class: { select: { name: true } }, examQuestions: { include: { question: true }, orderBy: { position: 'asc' } } },
    });
    const sums = await examSummaries([exam]);
    res.status(StatusCodes.OK).json({ exam: { ...full, stats: sums[exam.id] || { submitted: 0, inProgress: 0, locked: 0, pendingMarking: 0 } } });
};

const attachQuestions = async (tx, examId, rows) => {
    await tx.examQuestion.deleteMany({ where: { examId } });
    if (rows.length) await tx.examQuestion.createMany({ data: rows.map((r, i) => ({ examId, questionId: r.id, position: i + 1 })) });
};

const assertPublishable = async (examId, questionCount) => {
    if (questionCount < 1) throw new CustomError.BadRequestError('Add at least one question before publishing');
};

const createExam = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const b = req.body || {};
    const data = await examFields(req, b, cfg, null);
    const rows = Array.isArray(b.questionIds) ? await loadQuestionRows(req, b.questionIds, data.subjectId) : [];
    if (data.status === 'PUBLISHED') await assertPublishable(null, rows.length);
    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const exam = await prisma.$transaction(async (tx) => {
        const e = await tx.exam.create({ data: { ...data, schoolId: req.user.schoolId, ownerUserId: req.user.userId, ownerName: owner?.name || null, status: data.status || 'DRAFT' } });
        await attachQuestions(tx, e.id, rows);
        return e;
    });
    res.status(StatusCodes.CREATED).json({ msg: 'Exam created', exam });
};

const updateExam = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const existing = await findExam(req, req.params.id, { edit: true });
    const b = req.body || {};
    const started = await prisma.cBTResult.count({ where: { examId: existing.id } });
    const data = await examFields(req, b, cfg, existing);
    if (started && (data.classId !== existing.classId || data.subjectId !== existing.subjectId)) throw new CustomError.BadRequestError('The class and subject can’t change once students have started this exam');
    let rows = null;
    if (Array.isArray(b.questionIds)) {
        if (started) throw new CustomError.BadRequestError('Questions can’t be changed once students have started this exam. Duplicate the exam instead.');
        rows = await loadQuestionRows(req, b.questionIds, data.subjectId);
    }
    if (data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
        const count = rows ? rows.length : await prisma.examQuestion.count({ where: { examId: existing.id } });
        await assertPublishable(existing.id, count);
    }
    const exam = await prisma.$transaction(async (tx) => {
        const e = await tx.exam.update({ where: { id: existing.id }, data });
        if (rows) await attachQuestions(tx, existing.id, rows);
        return e;
    });
    res.status(StatusCodes.OK).json({ msg: 'Exam saved', exam });
};

const duplicateExam = async (req, res) => {
    const src = await findExam(req, req.params.id);
    const qs = await prisma.examQuestion.findMany({ where: { examId: src.id }, orderBy: { position: 'asc' } });
    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const { id, createdAt, updatedAt, ...rest } = src;
    const exam = await prisma.$transaction(async (tx) => {
        const e = await tx.exam.create({ data: { ...rest, title: `${src.title} (copy)`.slice(0, 200), status: 'DRAFT', resultRelease: 'INHERIT', ownerUserId: req.user.userId, ownerName: owner?.name || null, settings: src.settings ?? undefined } });
        if (qs.length) await tx.examQuestion.createMany({ data: qs.map(q => ({ examId: e.id, questionId: q.questionId, position: q.position })) });
        return e;
    });
    res.status(StatusCodes.CREATED).json({ msg: 'Exam duplicated as a draft', exam });
};

const deleteExam = async (req, res) => {
    const exam = await findExam(req, req.params.id, { edit: true });
    const attempts = await prisma.cBTResult.count({ where: { examId: exam.id } });
    if (attempts) {
        if (!isAdmin(req)) throw new CustomError.BadRequestError('Students have already taken this exam, so it can’t be deleted. Ask an administrator, or conclude it instead.');
        await prisma.exam.update({ where: { id: exam.id }, data: { isDeleted: true, status: 'CONCLUDED' } }); // keep results for the records
        return res.status(StatusCodes.OK).json({ msg: 'Exam archived (its results were kept)' });
    }
    await prisma.examEvent.deleteMany({ where: { examId: exam.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    res.status(StatusCodes.OK).json({ msg: 'Exam deleted' });
};

// ─── per-student exceptions: extra time & exemption ──────────────────────────
const classStudents = (exam) => prisma.studentProfile.findMany({
    where: { schoolId: exam.schoolId, classId: exam.classId, isDeleted: false },
    select: { id: true, admissionNo: true, user: { select: { name: true } } }, orderBy: { admissionNo: 'asc' },
}).then(rows => rows.map(r => ({ id: r.id, admissionNo: r.admissionNo, name: r.user?.name || r.admissionNo })).sort((a, b) => a.name.localeCompare(b.name)));

const getAccommodations = async (req, res) => {
    const exam = await findExam(req, req.params.id);
    const [students, accoms, attempts] = await Promise.all([
        classStudents(exam), prisma.examAccommodation.findMany({ where: { examId: exam.id } }),
        prisma.cBTResult.findMany({ where: { examId: exam.id }, select: { studentProfileId: true, status: true, extraMinutes: true } }),
    ]);
    const by = new Map(accoms.map(a => [a.studentProfileId, a])); const at = new Map(attempts.map(a => [a.studentProfileId, a]));
    res.status(StatusCodes.OK).json({
        students: students.map(s => ({ ...s, extraMinutes: by.get(s.id)?.extraMinutes || 0, exempted: !!by.get(s.id)?.exempted, note: by.get(s.id)?.note || '', attemptStatus: at.get(s.id)?.status || null })),
    });
};

const setAccommodation = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const exam = await findExam(req, req.params.id);
    const admin = isAdmin(req);
    const studentProfileId = req.params.studentProfileId;
    const b = req.body || {};
    const student = await prisma.studentProfile.findFirst({ where: { id: studentProfileId, schoolId: exam.schoolId, classId: exam.classId, isDeleted: false }, select: { id: true } });
    if (!student) throw new CustomError.NotFoundError('That student is not in this exam’s class');

    const cur = await prisma.examAccommodation.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId } } });
    const extra = b.extraMinutes === undefined ? cur?.extraMinutes || 0 : Math.round(Number(b.extraMinutes));
    const exempted = b.exempted === undefined ? !!cur?.exempted : !!b.exempted;
    if (!(extra >= 0 && extra <= 600)) throw new CustomError.BadRequestError('Extra time must be between 0 and 600 minutes');
    if (!admin) {
        if (extra !== (cur?.extraMinutes || 0) && !cfg.teacherCanAddTime) throw new CustomError.UnauthorizedError('Only an administrator can add time in the CBT settings');
        if (exempted !== !!cur?.exempted && !cfg.teacherCanExempt) throw new CustomError.UnauthorizedError('Only an administrator can exempt students');
    }
    const data = { extraMinutes: extra, exempted, note: b.note !== undefined ? String(b.note || '').slice(0, 300) : cur?.note ?? null };
    const acc = await prisma.examAccommodation.upsert({
        where: { examId_studentProfileId: { examId: exam.id, studentProfileId } }, update: data, create: { examId: exam.id, studentProfileId, createdBy: req.user.userId, ...data },
    });

    // extra time takes effect immediately for a student who is mid-exam
    const live = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId } } });
    if (live && live.status !== 'SUBMITTED' && live.deadlineAt && extra !== live.extraMinutes) {
        await prisma.cBTResult.update({ where: { id: live.id }, data: { deadlineAt: new Date(live.deadlineAt.getTime() + (extra - live.extraMinutes) * 60000), extraMinutes: extra } });
    }
    if (extra !== (cur?.extraMinutes || 0)) await logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId, type: 'EXTRA_TIME', detail: `${extra} minute(s) extra`, actorUserId: req.user.userId });
    res.status(StatusCodes.OK).json({ msg: 'Saved', accommodation: acc });
};

/** Adds the same extra time to everyone currently writing (e.g. a power cut or network outage). */
const extendAll = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const exam = await findExam(req, req.params.id);
    if (!isAdmin(req) && !cfg.teacherCanAddTime) throw new CustomError.UnauthorizedError('Only an administrator can add time in the CBT settings');
    const minutes = Math.round(Number(req.body?.minutes));
    if (!(minutes >= 1 && minutes <= 240)) throw new CustomError.BadRequestError('Add between 1 and 240 minutes');
    const live = await prisma.cBTResult.findMany({ where: { examId: exam.id, status: { in: ['IN_PROGRESS', 'LOCKED'] } } });
    await prisma.$transaction(live.map(a => prisma.cBTResult.update({ where: { id: a.id }, data: { deadlineAt: new Date(a.deadlineAt.getTime() + minutes * 60000), extraMinutes: { increment: minutes } } })));
    await Promise.all(live.map(a => logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: a.studentProfileId, type: 'EXTRA_TIME', detail: `+${minutes} min for everyone`, actorUserId: req.user.userId })));
    res.status(StatusCodes.OK).json({ msg: `Added ${minutes} minute${minutes === 1 ? '' : 's'} for ${live.length} student${live.length === 1 ? '' : 's'} writing now`, affected: live.length });
};

module.exports = {
    isAdmin, loadConfig, getTeacher, examScope, findExam, classStudents,
    getMeta, saveConfig,
    listQuestions, createQuestion, bulkCreateQuestions, updateQuestion, deleteQuestions, parseText, importFile, downloadTemplate, aiGenerate,
    listExams, getExam, createExam, updateExam, duplicateExam, deleteExam, getAccommodations, setAccommodation, extendAll,
};
