const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { loadConfig } = require('./cbt.controller');
const A = require('../services/cbt-attempt.service');
const { loadGrades, gradeFor } = require('../services/cbt-results.service');
const { scoreAttempt } = require('../services/cbt-content.service');

const httpError = (status, msg) => Object.assign(new CustomError.CustomAPIError(msg), { statusCode: status });
const LOCKED = (msg) => httpError(423, msg);

const getStudent = async (req) => {
    const s = await prisma.studentProfile.findFirst({ where: { userId: req.user.userId, isDeleted: false }, select: { id: true, classId: true, schoolId: true } });
    if (!s) throw new CustomError.NotFoundError('Student profile not found');
    return s;
};

const examFor = async (student, examId, { published = true } = {}) => {
    const exam = await prisma.exam.findFirst({
        where: { id: examId, schoolId: student.schoolId, classId: student.classId, isDeleted: false, ...(published && { status: 'PUBLISHED' }) },
        include: { subject: { select: { name: true } }, class: { select: { name: true } } },
    });
    if (!exam) throw new CustomError.NotFoundError('Exam not found or not available to you');
    return exam;
};

const deviceOf = (b) => {
    const d = String(b?.deviceId || '');
    if (d.length < 8 || d.length > 100) throw new CustomError.BadRequestError('This browser could not be identified. Refresh the page and try again.');
    return d;
};

const MAX_ANSWER = 20000;
/** Keeps only answers to questions in this exam, with a sane size. */
const cleanAnswers = (incoming, validIds) => {
    const out = {};
    for (const [k, v] of Object.entries(incoming && typeof incoming === 'object' ? incoming : {})) {
        if (!validIds.has(k) || v == null) continue;
        out[k] = String(v).slice(0, MAX_ANSWER);
    }
    return out;
};

/** The same student appearing from a second device mid-exam: block, and (by policy) lock the attempt until an admin releases it. */
const deviceConflict = async (attempt, exam, cfg, deviceId, where) => {
    await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: attempt.studentProfileId, type: 'DEVICE_CONFLICT', detail: `${where} from a different device` });
    if (cfg.lockOnSecondDevice) {
        await prisma.cBTResult.updateMany({ where: { id: attempt.id, status: 'IN_PROGRESS' }, data: { status: 'LOCKED', lockReason: 'The exam was opened from a second device' } });
        await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: attempt.studentProfileId, type: 'LOCKED', detail: 'Second device detected' });
        throw LOCKED('This exam is already open on another device, so it has been locked. Please see your invigilator or the school administrator to release it.');
    }
    throw LOCKED('This exam is already open on another device. Close it there first.');
};

const lockedMessage = (a) => `Your exam is locked${a.lockReason ? ` (${a.lockReason})` : ''}. Please see your invigilator or the school administrator to release it.`;

// ─── list ────────────────────────────────────────────────────────────────────
const listMyExams = async (req, res) => {
    const student = await getStudent(req);
    const cfg = await loadConfig(student.schoolId);
    if (!student.classId) return res.status(StatusCodes.OK).json({ exams: [], serverNow: new Date().toISOString(), config: { offlineEnabled: cfg.offlineEnabled } });

    const exams = await prisma.exam.findMany({
        where: { schoolId: student.schoolId, classId: student.classId, isDeleted: false, status: { in: ['PUBLISHED', 'CONCLUDED'] } },
        include: { subject: { select: { name: true } }, _count: { select: { examQuestions: true } } }, orderBy: [{ startTime: 'desc' }, { createdAt: 'desc' }],
    });
    const [attempts, accoms, grades] = await Promise.all([
        prisma.cBTResult.findMany({ where: { studentProfileId: student.id, examId: { in: exams.map(e => e.id) } } }),
        prisma.examAccommodation.findMany({ where: { studentProfileId: student.id, examId: { in: exams.map(e => e.id) } } }),
        loadGrades(student.schoolId),
    ]);
    const now = Date.now();
    const out = [];
    // time ran out without a submit → close it now so the list (and the result) is up to date
    const closed = await Promise.all(attempts.map(a => (a.status !== 'SUBMITTED' && A.isExpired(a, now) ? A.finalizeAttempt(a, { method: 'TIMEOUT' }) : a)));
    const by = new Map(closed.map(a => [a.examId, a])); const accBy = new Map(accoms.map(a => [a.examId, a]));

    for (const e of exams) {
        const a = by.get(e.id); const acc = accBy.get(e.id);
        let state;
        if (acc?.exempted) state = 'EXEMPTED';
        else if (a?.status === 'SUBMITTED') state = 'SUBMITTED';
        else if (a?.status === 'LOCKED') state = 'LOCKED';
        else if (a?.status === 'IN_PROGRESS') state = 'IN_PROGRESS';
        else if (e.status === 'CONCLUDED' || (e.endTime && now > e.endTime.getTime())) state = 'CLOSED';
        else if (e.startTime && now < e.startTime.getTime()) state = 'UPCOMING';
        else state = 'OPEN';
        if (e.status === 'CONCLUDED' && !a && state !== 'EXEMPTED') continue;
        const visible = A.resultVisible(e, cfg, a);
        out.push({
            id: e.id, title: e.title, instructions: e.instructions || '', subjectName: e.subject?.name, durationMinutes: e.durationMinutes + (acc?.extraMinutes || 0), questionCount: e._count.examQuestions,
            startTime: e.startTime, endTime: e.endTime, term: e.term, sessionName: e.sessionName, state, deadlineAt: a?.status === 'IN_PROGRESS' ? a.deadlineAt : null,
            extraMinutes: acc?.extraMinutes || 0, submittedAt: a?.submittedAt || null, resultVisible: visible,
            result: visible ? (({ score, maxScore, percentage, grade, passed, pending }) => ({ score, maxScore, percentage, grade, passed, pending }))(A.studentResult(e, cfg, a, gradeFor(a.totalScore, grades))) : null,
            awaitingRelease: state === 'SUBMITTED' && !visible,
        });
    }
    res.status(StatusCodes.OK).json({ exams: out, serverNow: new Date().toISOString(), config: { offlineEnabled: cfg.offlineEnabled } });
};

// ─── start / resume ──────────────────────────────────────────────────────────
const startExam = async (req, res) => {
    const student = await getStudent(req);
    const exam = await examFor(student, req.params.id);
    const cfg = await loadConfig(student.schoolId);
    const deviceId = deviceOf(req.body);

    const acc = await prisma.examAccommodation.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId: student.id } } });
    if (acc?.exempted) throw httpError(403, 'You have been exempted from this exam.');

    let attempt = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId: student.id } } });
    const questions = await A.loadQuestions(exam.id);
    if (!questions.length) throw new CustomError.BadRequestError('This exam has no questions yet.');

    if (attempt) {
        if (attempt.status === 'SUBMITTED') throw httpError(409, 'You have already submitted this exam.');
        if (A.isExpired(attempt)) { await A.finalizeAttempt(attempt, { questions, method: 'TIMEOUT' }); throw httpError(409, 'Your time for this exam is over. Your answers were submitted.'); }
        if (attempt.status === 'LOCKED') throw LOCKED(lockedMessage(attempt));
        if (cfg.singleDeviceLock && attempt.deviceId && attempt.deviceId !== deviceId) await deviceConflict(attempt, exam, cfg, deviceId, 'Exam opened');
        attempt = await prisma.cBTResult.update({ where: { id: attempt.id }, data: { deviceId, lastSeenAt: new Date() } });
    } else {
        const now = Date.now();
        if (exam.startTime && now < exam.startTime.getTime()) throw httpError(403, 'This exam has not opened yet.');
        if (exam.endTime && now > exam.endTime.getTime()) throw httpError(403, 'The time to start this exam has passed.');
        const extra = acc?.extraMinutes || 0;
        try {
            attempt = await prisma.cBTResult.create({
                data: {
                    examId: exam.id, studentProfileId: student.id, status: 'IN_PROGRESS', deviceId, startedAt: new Date(now), extraMinutes: extra, lastSeenAt: new Date(now),
                    deadlineAt: new Date(now + (exam.durationMinutes + extra) * 60000), maxScore: questions.reduce((n, q) => n + q.marks, 0), answers: {},
                },
            });
            await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: student.id, type: 'STARTED' });
        } catch (e) {
            if (e.code !== 'P2002') throw e; // double-click / two tabs: someone else just created it
            attempt = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId: student.id } } });
            if (attempt.deviceId && attempt.deviceId !== deviceId) await deviceConflict(attempt, exam, cfg, deviceId, 'Exam opened');
        }
    }
    res.status(StatusCodes.OK).json(A.buildExamPayload({ exam, questions, attempt, cfg }));
};

/** Shared guard for save / submit: the attempt must be live, on this device, and inside its time. */
const liveAttempt = async (req) => {
    const student = await getStudent(req);
    const exam = await examFor(student, req.params.id, { published: false });
    const cfg = await loadConfig(student.schoolId);
    const deviceId = deviceOf(req.body);
    const attempt = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId: student.id } } });
    if (!attempt) throw new CustomError.NotFoundError('You have not started this exam.');
    return { student, exam, cfg, deviceId, attempt };
};

const checkDevice = async ({ attempt, exam, cfg, deviceId }, where) => {
    if (attempt.status === 'LOCKED') throw LOCKED(lockedMessage(attempt));
    if (cfg.singleDeviceLock && attempt.deviceId && attempt.deviceId !== deviceId) await deviceConflict(attempt, exam, cfg, deviceId, where);
};

// ─── autosave (also the heartbeat) ───────────────────────────────────────────
const saveProgress = async (req, res) => {
    const ctx = await liveAttempt(req);
    const { attempt, exam } = ctx;
    if (attempt.status === 'SUBMITTED') return res.status(StatusCodes.OK).json({ status: 'SUBMITTED', serverNow: new Date().toISOString() });
    await checkDevice(ctx, 'Answers saved');

    const questions = await A.loadQuestions(exam.id);
    if (A.isExpired(attempt)) { await A.finalizeAttempt(attempt, { questions, method: 'TIMEOUT' }); return res.status(StatusCodes.OK).json({ status: 'SUBMITTED', serverNow: new Date().toISOString() }); }

    const merged = { ...(attempt.answers || {}), ...cleanAnswers(req.body.answers, new Set(questions.map(q => q.id))) };
    const updated = await prisma.cBTResult.update({ where: { id: attempt.id }, data: { answers: merged, lastSeenAt: new Date(), deviceId: attempt.deviceId || ctx.deviceId } });
    res.status(StatusCodes.OK).json({ status: updated.status, serverNow: new Date().toISOString(), deadlineAt: updated.deadlineAt });
};

// ─── submit (online, or the sync after an offline finish) ────────────────────
const submitExam = async (req, res) => {
    const ctx = await liveAttempt(req);
    const { attempt, exam, cfg, student } = ctx;
    const grades = await loadGrades(student.schoolId);
    const now = Date.now();
    const b = req.body || {};
    const finishedAt = b.finishedAt ? new Date(b.finishedAt) : null;
    const clientFinish = finishedAt && !Number.isNaN(finishedAt.getTime()) ? finishedAt : null;
    const offline = !!b.offline;
    const questions = await A.loadQuestions(exam.id);
    const ids = new Set(questions.map(q => q.id));
    const deadline = attempt.deadlineAt.getTime();
    const syncWindowOk = now <= deadline + cfg.offlineSyncWindowHours * 3600 * 1000;
    const finishedInTime = !!clientFinish && clientFinish.getTime() <= deadline + A.CLIENT_CLOCK_TOLERANCE_MS;
    const offlineLegit = cfg.offlineEnabled && offline && finishedInTime && syncWindowOk;

    const respond = (row, extra = {}) => {
        const visible = A.resultVisible(exam, cfg, row);
        res.status(StatusCodes.OK).json({
            submitted: true, resultVisible: visible, awaitingRelease: !visible,
            result: visible ? A.studentResult(exam, cfg, row, gradeFor(row.totalScore, grades), null) : null, ...extra,
        });
    };

    if (attempt.status === 'SUBMITTED') {
        // A retry of a request we already processed → fine. A TIMEOUT close that an offline sync can still correct → upgrade it.
        if (attempt.submitMethod === 'TIMEOUT' && !attempt.syncedOffline && offlineLegit) {
            const answers = { ...(attempt.answers || {}), ...cleanAnswers(b.answers, ids) };
            const row = await prisma.cBTResult.update({ where: { id: attempt.id }, data: { answers, ...scoreAttempt(questions, answers, attempt.essayMarks || {}), syncedOffline: true, clientFinishedAt: clientFinish } });
            await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: student.id, type: 'OFFLINE_SYNC', detail: 'Late sync replaced timeout answers' });
            return respond(row, { synced: true });
        }
        return respond(attempt, { alreadySubmitted: true });
    }
    await checkDevice(ctx, 'Submission');

    let answers = attempt.answers || {}; let syncedOffline = false; let method = b.auto ? 'TIMEOUT' : 'MANUAL';
    if (now <= deadline + A.GRACE_MS) {
        answers = { ...answers, ...cleanAnswers(b.answers, ids) };
        syncedOffline = offline;
    } else if (offlineLegit) {
        answers = { ...answers, ...cleanAnswers(b.answers, ids) };
        syncedOffline = true;
    } else {
        method = 'TIMEOUT'; // too late: only what was autosaved in time counts
    }
    const row = await A.finalizeAttempt(attempt, { questions, answers, method, syncedOffline, clientFinishedAt: clientFinish });
    if (syncedOffline && now > deadline) await A.logExamEvent({ schoolId: exam.schoolId, examId: exam.id, studentProfileId: student.id, type: 'OFFLINE_SYNC', detail: 'Submitted after reconnecting' });
    respond(row);
};

// ─── a student's own result ──────────────────────────────────────────────────
const getMyResult = async (req, res) => {
    const student = await getStudent(req);
    const exam = await examFor(student, req.params.id, { published: false });
    const cfg = await loadConfig(student.schoolId);
    const attempt = await prisma.cBTResult.findUnique({ where: { examId_studentProfileId: { examId: exam.id, studentProfileId: student.id } } });
    if (!attempt || attempt.status !== 'SUBMITTED') throw new CustomError.NotFoundError('You have not submitted this exam.');
    if (!A.resultVisible(exam, cfg, attempt)) throw httpError(403, 'Your result has not been released yet.');
    const grades = await loadGrades(student.schoolId);
    const questions = cfg.studentSeesBreakdown ? await A.loadQuestions(exam.id) : null;
    res.status(StatusCodes.OK).json({ result: A.studentResult(exam, cfg, attempt, gradeFor(attempt.totalScore, grades), questions) });
};

module.exports = { listMyExams, startExam, saveProgress, submitExam, getMyResult };

// ─── results list for a student / their parent / staff (visibility rules apply to the first two) ───
const listResultsFor = async (req, res) => {
    const { schoolId, role, userId } = req.user;
    let studentProfileId = req.query.studentProfileId;
    const learner = role === 'STUDENT' || role === 'PARENT';

    if (role === 'STUDENT') studentProfileId = (await getStudent(req)).id;
    else if (!studentProfileId) throw new CustomError.BadRequestError('Please provide studentProfileId');

    const owns = await prisma.studentProfile.findFirst({
        where: { id: studentProfileId, schoolId, isDeleted: false, ...(role === 'PARENT' && { parent: { userId } }) }, select: { id: true },
    });
    if (!owns) throw new CustomError.NotFoundError('Student not found');
    if (!learner && !['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'].includes(role)) throw new CustomError.UnauthorizedError('Unauthorized to access this route');

    const cfg = await loadConfig(schoolId);
    const attempts = await prisma.cBTResult.findMany({
        where: { studentProfileId, status: 'SUBMITTED', exam: { schoolId, isDeleted: false } },
        include: { exam: { include: { subject: { select: { name: true } } } } }, orderBy: { submittedAt: 'desc' },
    });
    const grades = await loadGrades(schoolId);
    const results = attempts.filter(a => !learner || A.resultVisible(a.exam, cfg, a)).map(a => ({
        id: a.id, examId: a.examId, totalScore: a.totalScore, grade: gradeFor(a.totalScore, grades).grade, pending: a.markingStatus === 'PENDING',
        createdAt: a.submittedAt, exam: { title: a.exam.title, durationMinutes: a.exam.durationMinutes, passingMarks: a.exam.passingMarks, subject: a.exam.subject },
    }));
    res.status(StatusCodes.OK).json({ count: results.length, results });
};

module.exports.listResultsFor = listResultsFor;
