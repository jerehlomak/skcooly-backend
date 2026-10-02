const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { getTransporter, getFromEmail } = require('../utils/emailTransporter');
const C = require('./cbt.controller');
const A = require('../services/cbt-attempt.service');
const R = require('../services/cbt-results.service');
const cbtAi = require('../services/cbt-ai.service');
const { scoreAttempt } = require('../services/cbt-content.service');

const { isAdmin, loadConfig, findExam, classStudents } = C;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminOnly = (req, what) => { if (!isAdmin(req)) throw new CustomError.UnauthorizedError(`Only an administrator can ${what}`); };

const loadSchool = (schoolId) => prisma.schoolSettings.findFirst({ where: { schoolId }, select: { schoolName: true, arabicName: true, logoUrl: true, address: true } });
const stamp = (e) => [e.className, e.subjectName, e.term, e.sessionName].filter(Boolean).join(' · ');

// ─── single exam: results sheet ──────────────────────────────────────────────
const examSheetData = async (exam) => {
    await A.sweepExpired(exam.id);
    const [students, attempts, accommodations, grades] = await Promise.all([
        classStudents(exam), prisma.cBTResult.findMany({ where: { examId: exam.id } }),
        prisma.examAccommodation.findMany({ where: { examId: exam.id } }), R.loadGrades(exam.schoolId),
    ]);
    const sheet = R.buildExamSheet({ exam, students, attempts, accommodations, grades });
    const by = new Map(attempts.map(a => [a.studentProfileId, a]));
    sheet.rows.forEach(r => {
        const a = by.get(r.studentProfileId);
        r.attempt = a ? {
            status: a.status, lockReason: a.lockReason, lastSeenAt: a.lastSeenAt, startedAt: a.startedAt, deadlineAt: a.deadlineAt,
            answered: Object.values(a.answers || {}).filter(v => String(v).trim()).length, submitMethod: a.submitMethod,
        } : null;
    });
    return { ...sheet, grades, students, attempts };
};

const withNames = async (examId) => {
    const e = await prisma.exam.findUnique({ where: { id: examId }, include: { subject: { select: { name: true } }, class: { select: { name: true } }, _count: { select: { examQuestions: true } } } });
    return e;
};

const getExamResults = async (req, res) => {
    const base = await findExam(req, req.params.id);
    const exam = await withNames(base.id);
    const { rows, stats } = await examSheetData(exam);
    const maxScore = (await prisma.examQuestion.findMany({ where: { examId: exam.id }, select: { question: { select: { marks: true, type: true } } } }));
    res.status(StatusCodes.OK).json({
        exam: { id: exam.id, title: exam.title, className: exam.class.name, subjectName: exam.subject.name, term: exam.term, sessionName: exam.sessionName, status: exam.status, passingMarks: exam.passingMarks, resultRelease: exam.resultRelease, questionCount: exam._count.examQuestions, totalMarks: maxScore.reduce((n, q) => n + q.question.marks, 0), essayCount: maxScore.filter(q => q.question.type === 'ESSAY').length },
        rows, stats,
    });
};

// ─── marking essays ──────────────────────────────────────────────────────────
const assertCanMark = async (req) => {
    if (isAdmin(req)) return;
    const cfg = await loadConfig(req.user.schoolId);
    if (!cfg.teacherCanMarkEssays) throw new CustomError.UnauthorizedError('Marking is restricted to administrators in the CBT settings');
};

const loadAttempt = async (exam, studentProfileId) => {
    const attempt = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId } } });
    if (!attempt) throw new CustomError.NotFoundError('This student has not taken the exam');
    return attempt;
};

const getAttempt = async (req, res) => {
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    const [questions, student, events] = await Promise.all([
        A.loadQuestions(exam.id),
        prisma.studentProfile.findUnique({ where: { id: attempt.studentProfileId }, select: { admissionNo: true, user: { select: { name: true } } } }),
        prisma.examEvent.findMany({ where: { examId: exam.id, studentProfileId: attempt.studentProfileId }, orderBy: { createdAt: 'asc' } }),
    ]);
    res.status(StatusCodes.OK).json({
        student: { name: student?.user?.name, admissionNo: student?.admissionNo }, events,
        attempt: { id: attempt.id, status: attempt.status, answers: attempt.answers || {}, itemScores: attempt.itemScores || {}, essayMarks: attempt.essayMarks || {}, objectiveScore: attempt.objectiveScore, essayScore: attempt.essayScore, maxScore: attempt.maxScore, totalScore: attempt.totalScore, markingStatus: attempt.markingStatus, submittedAt: attempt.submittedAt, syncedOffline: attempt.syncedOffline, submitMethod: attempt.submitMethod },
        questions: questions.map((q, i) => ({ id: q.id, number: i + 1, type: q.type, text: q.questionText, options: q.options, correctAnswer: q.correctAnswer, marks: q.marks, explanation: q.explanation })),
    });
};

const saveMarks = async (req, res) => {
    await assertCanMark(req);
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    if (attempt.status !== 'SUBMITTED') throw new CustomError.BadRequestError('Only submitted exams can be marked');
    const questions = await A.loadQuestions(exam.id);
    const essays = new Map(questions.filter(q => q.type === 'ESSAY').map(q => [q.id, q]));
    const incoming = req.body?.marks && typeof req.body.marks === 'object' ? req.body.marks : {};
    const merged = { ...(attempt.essayMarks || {}) };
    for (const [qid, m] of Object.entries(incoming)) {
        const q = essays.get(qid);
        if (!q) throw new CustomError.BadRequestError('You can only mark essay questions');
        if (m === null || m.score === null || m.score === '' || m.score === undefined) { delete merged[qid]; continue; }
        const score = Math.round(Number(m.score) * 100) / 100;
        if (!Number.isFinite(score) || score < 0 || score > q.marks) throw new CustomError.BadRequestError(`A mark for this question must be between 0 and ${q.marks}`);
        merged[qid] = { score, comment: String(m.comment || '').slice(0, 1000), markedBy: req.user.userId, markedAt: new Date().toISOString() };
    }
    const score = scoreAttempt(questions, attempt.answers || {}, merged);
    const row = await prisma.cBTResult.update({ where: { id: attempt.id }, data: { essayMarks: merged, ...score } });
    res.status(StatusCodes.OK).json({ msg: 'Marks saved', attempt: { objectiveScore: row.objectiveScore, essayScore: row.essayScore, maxScore: row.maxScore, totalScore: row.totalScore, markingStatus: row.markingStatus, essayMarks: row.essayMarks } });
};

/** "Mark by question": every student's answer to one essay question, side by side. */
const getMarkingQueue = async (req, res) => {
    const exam = await findExam(req, req.params.id);
    const questions = (await A.loadQuestions(exam.id)).map((q, i) => ({ ...q, number: i + 1 })).filter(q => q.type === 'ESSAY');
    const attempts = await prisma.cBTResult.findMany({ where: { examId: exam.id, status: 'SUBMITTED' }, include: { student: { select: { admissionNo: true, user: { select: { name: true } } } } } });
    const { questionId } = req.query;
    const summary = questions.map(q => ({
        id: q.id, number: q.number, text: q.questionText, marks: q.marks, guide: q.correctAnswer,
        total: attempts.length, marked: attempts.filter(a => a.essayMarks?.[q.id]).length,
    }));
    const q = questions.find(x => x.id === questionId);
    const items = q ? attempts.map(a => ({
        studentProfileId: a.studentProfileId, name: a.student?.user?.name || a.student?.admissionNo, admissionNo: a.student?.admissionNo,
        answer: String(a.answers?.[q.id] ?? ''), score: a.essayMarks?.[q.id]?.score ?? null, comment: a.essayMarks?.[q.id]?.comment || '',
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
    res.status(StatusCodes.OK).json({ questions: summary, items });
};

const aiSuggest = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    await assertCanMark(req);
    if (!isAdmin(req)) {
        if (!cfg.teacherAiEnabled) throw new CustomError.UnauthorizedError('AI is turned off for teachers in the CBT settings');
        if ((await cbtAi.getUsage(req.user.userId)) >= cfg.teacherDailyAiLimit) throw new CustomError.BadRequestError(`You have reached today's limit of ${cfg.teacherDailyAiLimit} AI requests.`);
    }
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    const q = (await A.loadQuestions(exam.id)).find(x => x.id === req.body?.questionId && x.type === 'ESSAY');
    if (!q) throw new CustomError.BadRequestError('Choose an essay question');
    try {
        const out = await cbtAi.suggestEssayMark({ questionHtml: q.questionText, guide: q.correctAnswer, answer: attempt.answers?.[q.id], maxMarks: q.marks });
        await cbtAi.bumpUsage(req.user.userId);
        res.status(StatusCodes.OK).json(out);
    } catch (e) { res.status(e.status || 502).json({ msg: e.message }); }
};

// ─── admin controls on a live attempt ────────────────────────────────────────
const logAndOk = async (req, exam, studentProfileId, type, detail, msg, res) => {
    await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId, type, detail, actorUserId: req.user.userId });
    res.status(StatusCodes.OK).json({ msg });
};

/** Clears a lock (and the device binding) so the student can carry on — from the same or another device. */
const releaseAttempt = async (req, res) => {
    adminOnly(req, 'release a locked exam');
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    if (attempt.status === 'SUBMITTED') throw new CustomError.BadRequestError('This exam was already submitted');
    // keep the clock honest: if the lock outlived the time, the student gets the remaining minutes back only when an admin adds time
    await prisma.cBTResult.update({ where: { id: attempt.id }, data: { status: 'IN_PROGRESS', lockReason: null, deviceId: null } });
    await logAndOk(req, exam, attempt.studentProfileId, 'RELEASED', null, 'Released — the student can continue now', res);
};

const resetAttempt = async (req, res) => {
    adminOnly(req, 'reset a student’s exam');
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    await prisma.cBTResult.delete({ where: { id: attempt.id } });
    await logAndOk(req, exam, attempt.studentProfileId, 'RESET', `Attempt deleted (was ${attempt.status})`, 'Exam reset — the student can start again', res);
};

const forceSubmit = async (req, res) => {
    adminOnly(req, 'submit on a student’s behalf');
    const exam = await findExam(req, req.params.id);
    const attempt = await loadAttempt(exam, req.params.studentProfileId);
    if (attempt.status === 'SUBMITTED') throw new CustomError.BadRequestError('Already submitted');
    await A.finalizeAttempt(attempt, { method: 'ADMIN' });
    res.status(StatusCodes.OK).json({ msg: 'Submitted with the answers saved so far' });
};

const setRelease = async (req, res) => {
    adminOnly(req, 'release results to students');
    const mode = req.body?.mode;
    if (!['INHERIT', 'HIDDEN', 'RELEASED'].includes(mode)) throw new CustomError.BadRequestError('mode must be INHERIT, HIDDEN or RELEASED');
    const exam = await findExam(req, req.params.id);
    await prisma.exam.update({ where: { id: exam.id }, data: { resultRelease: mode } });
    res.status(StatusCodes.OK).json({ msg: mode === 'RELEASED' ? 'Results are now visible to students' : mode === 'HIDDEN' ? 'Results are hidden from students' : 'Results follow the school policy', resultRelease: mode });
};

// ─── class master sheet ──────────────────────────────────────────────────────
const masterScope = async (req, q) => {
    if (!q.classId) throw new CustomError.BadRequestError('Choose a class');
    const exams = await prisma.exam.findMany({
        where: { AND: [await C.examScope(req), { classId: q.classId, status: { not: 'DRAFT' }, ...(q.term && { term: q.term }), ...(q.sessionName && { sessionName: q.sessionName }), ...(q.subjectId && { subjectId: q.subjectId }) }] },
        include: { subject: { select: { name: true } }, class: { select: { name: true } } }, orderBy: [{ subject: { name: 'asc' } }, { createdAt: 'asc' }],
    });
    return exams;
};

const masterData = async (schoolId, classId, exams) => {
    const examIds = exams.map(e => e.id);
    await Promise.all(examIds.map(A.sweepExpired));
    const [students, attempts, accommodations, grades] = await Promise.all([
        classStudents({ schoolId, classId }), prisma.cBTResult.findMany({ where: { examId: { in: examIds } } }),
        prisma.examAccommodation.findMany({ where: { examId: { in: examIds } } }), R.loadGrades(schoolId),
    ]);
    const meta = exams.map(e => ({ id: e.id, title: e.title, subjectName: e.subject.name, passingMarks: e.passingMarks, term: e.term, sessionName: e.sessionName }));
    return { meta, ...R.buildMasterSheet({ exams: meta, students, attempts, accommodations, grades }) };
};

const getMasterSheet = async (req, res) => {
    const exams = await masterScope(req, req.query);
    const cls = await prisma.class.findFirst({ where: { id: req.query.classId, schoolId: req.user.schoolId }, select: { name: true } });
    const data = await masterData(req.user.schoolId, req.query.classId, exams);
    res.status(StatusCodes.OK).json({ className: cls?.name, term: req.query.term || null, sessionName: req.query.sessionName || null, exams: data.meta, rows: data.rows, subjectStats: data.subjectStats });
};

// ─── export, print, share ────────────────────────────────────────────────────
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const fmtOf = (f) => (f === 'xlsx' ? 'xlsx' : 'pdf');
const safeName = (s) => String(s || 'results').replace(/[^\w\- ]+/g, '_').slice(0, 80);

const renderExam = async (schoolId, examId, format) => {
    const exam = await withNames(examId);
    if (!exam || exam.schoolId !== schoolId) throw new CustomError.NotFoundError('Exam not found');
    const [{ rows, stats }, cfg, school] = await Promise.all([examSheetData(exam), loadConfig(schoolId), loadSchool(schoolId)]);
    const title = `${exam.title} — Results`;
    const subtitle = stamp({ className: exam.class.name, subjectName: exam.subject.name, term: exam.term, sessionName: exam.sessionName });
    const footer = [`Enrolled: ${stats.enrolled}  ·  Submitted: ${stats.submitted}  ·  Absent: ${stats.absent}  ·  Exempted: ${stats.exempted}`,
        `Average: ${stats.average}%  ·  Highest: ${stats.highest}%  ·  Lowest: ${stats.lowest}%  ·  Pass rate (≥${exam.passingMarks}%): ${stats.passRate}%`,
        ...(stats.pendingMarking ? [`${stats.pendingMarking} script(s) still have essays waiting to be marked — their totals are not final.`] : [])];
    const table = R.examTable({ rows });
    const buffer = format === 'xlsx' ? R.toXlsx({ school, title, subtitle, table, footer }) : await R.toPdf({ school, cfg, title, subtitle, table, footer });
    return { buffer, format, name: safeName(`${exam.title} results`) };
};

const renderMaster = async (schoolId, classId, examIds, meta, format) => {
    const exams = await prisma.exam.findMany({ where: { id: { in: examIds }, schoolId }, include: { subject: { select: { name: true } }, class: { select: { name: true } } }, orderBy: [{ subject: { name: 'asc' } }, { createdAt: 'asc' }] });
    if (!exams.length) throw new CustomError.NotFoundError('There are no exams for this master sheet');
    const [data, cfg, school, cls] = await Promise.all([masterData(schoolId, classId, exams), loadConfig(schoolId), loadSchool(schoolId), prisma.class.findUnique({ where: { id: classId }, select: { name: true } })]);
    const title = `${cls?.name || 'Class'} — CBT Master Sheet`;
    const subtitle = [meta?.term, meta?.sessionName].filter(Boolean).join(' · ') || 'All terms';
    const footer = ['Scores are percentages. EX = exempted, ABS = absent, … = not finished, * = essay marking still pending.', 'Average is taken over the exams the student sat. Position is by average.'];
    const table = R.masterTable(data.meta, data);
    const landscape = data.meta.length > 4;
    const buffer = format === 'xlsx' ? R.toXlsx({ school, title, subtitle, table, footer }) : await R.toPdf({ school, cfg, title, subtitle, table, footer, landscape });
    return { buffer, format, name: safeName(`${cls?.name || 'class'} master sheet`) };
};

const send = (res, out) => {
    res.setHeader('Content-Type', MIME[out.format]);
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}.${out.format}"`);
    res.status(StatusCodes.OK).end(out.buffer);
};

const exportExam = async (req, res) => {
    const exam = await findExam(req, req.params.id);
    send(res, await renderExam(req.user.schoolId, exam.id, fmtOf(req.query.format)));
};

const exportMaster = async (req, res) => {
    const exams = await masterScope(req, req.query);
    send(res, await renderMaster(req.user.schoolId, req.query.classId, exams.map(e => e.id), req.query, fmtOf(req.query.format)));
};

/** Resolves a share request to the render call it stands for: { kind, ... } */
const shareTarget = async (req) => {
    const b = req.body || {};
    if (b.kind === 'MASTER') {
        const exams = await masterScope(req, b);
        if (!exams.length) throw new CustomError.BadRequestError('There are no exams to share for these filters');
        return { kind: 'MASTER', classId: b.classId, examIds: exams.slice(0, 60).map(e => e.id), meta: { term: b.term || null, sessionName: b.sessionName || null }, title: `CBT master sheet${b.term ? ` — ${b.term}` : ''}` };
    }
    const exam = await findExam(req, b.examId);
    return { kind: 'EXAM', examId: exam.id, title: `${exam.title} — Results` };
};

const renderTarget = (schoolId, t, format) => (t.kind === 'MASTER' ? renderMaster(schoolId, t.classId, t.examIds, t.meta, format) : renderExam(schoolId, t.examId, format));

const shareEmail = async (req, res) => {
    const t = await shareTarget(req);
    const to = [...new Set((Array.isArray(req.body.to) ? req.body.to : String(req.body.to || '').split(/[,\s;]+/)).map(s => s.trim()).filter(Boolean))];
    if (!to.length) throw new CustomError.BadRequestError('Enter at least one email address');
    if (to.length > 10) throw new CustomError.BadRequestError('You can email up to 10 people at once');
    const bad = to.find(e => !EMAIL_RE.test(e));
    if (bad) throw new CustomError.BadRequestError(`"${bad}" is not a valid email address`);

    const format = fmtOf(req.body.format);
    const file = await renderTarget(req.user.schoolId, t, format);
    const [school, sender] = await Promise.all([loadSchool(req.user.schoolId), prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true, email: true } })]);
    const note = String(req.body.message || '').slice(0, 1000).replace(/[<>]/g, '');
    try {
        const transporter = await getTransporter(req.user.schoolId);
        await transporter.sendMail({
            from: await getFromEmail(req.user.schoolId), to, replyTo: sender?.email, subject: t.title,
            html: `<div style="font-family:sans-serif"><p>${note ? note.replace(/\n/g, '<br/>') : `${sender?.name || 'A teacher'} shared CBT results with you.`}</p><p><strong>${t.title}</strong></p><p style="color:#888;font-size:12px">Sent from ${school?.schoolName || 'School'} via Skooly</p></div>`,
            attachments: [{ filename: `${file.name}.${format}`, content: file.buffer, contentType: MIME[format] }],
        });
    } catch (e) {
        console.error('[cbt] share email failed:', e.message);
        throw new CustomError.BadRequestError('The email could not be sent. Check the school\'s email (SMTP) settings.');
    }
    res.status(StatusCodes.OK).json({ msg: `Sent to ${to.length} recipient${to.length === 1 ? '' : 's'}` });
};

const createShareLink = async (req, res) => {
    const t = await shareTarget(req);
    const format = fmtOf(req.body.format);
    const days = Math.min(30, Math.max(1, Number(req.body.days) || 7));
    const { title, ...target } = t;
    const token = jwt.sign({ ...target, schoolId: req.user.schoolId, format, purpose: 'cbt-share' }, process.env.JWT_SECRET, { expiresIn: `${days}d` });
    res.status(StatusCodes.OK).json({ url: `${req.protocol}://${req.get('host')}/api/v1/cbt/public/${token}`, expiresInDays: days, title });
};

const publicDownload = async (req, res) => {
    let p;
    try { p = jwt.verify(req.params.token, process.env.JWT_SECRET); } catch { throw new CustomError.UnauthenticatedError('This link has expired or is invalid'); }
    if (p.purpose !== 'cbt-share') throw new CustomError.UnauthenticatedError('This link is invalid');
    send(res, await renderTarget(p.schoolId, p, fmtOf(p.format)));
};

module.exports = {
    getExamResults, getAttempt, saveMarks, getMarkingQueue, aiSuggest, releaseAttempt, resetAttempt, forceSubmit, setRelease,
    getMasterSheet, exportExam, exportMaster, shareEmail, createShareLink, publicDownload,
};
