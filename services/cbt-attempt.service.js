const prisma = require('../db/prisma');
const { scoreAttempt, shuffled } = require('./cbt-content.service');

/** Seconds of slack after the deadline before the server stops accepting live answers (network latency). */
const GRACE_MS = 90 * 1000;
/** How far past the deadline a device's own clock may claim it finished (an offline attempt). */
const CLIENT_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

const logExamEvent = (e) => prisma.examEvent.create({ data: { schoolId: e.schoolId, examId: e.examId, studentProfileId: e.studentProfileId, type: e.type, detail: e.detail || null, actorUserId: e.actorUserId || null } }).catch(() => {});

const loadQuestions = async (examId) => {
    const rows = await prisma.examQuestion.findMany({ where: { examId }, include: { question: true }, orderBy: { position: 'asc' } });
    return rows.map(r => r.question);
};

const isExpired = (attempt, now = Date.now()) => !!attempt.deadlineAt && now > attempt.deadlineAt.getTime() + GRACE_MS;

/** Scores and closes an attempt. Safe to call twice: only the first call wins. Returns the final row. */
const finalizeAttempt = async (attempt, { questions, answers, method, syncedOffline = false, clientFinishedAt = null }) => {
    const qs = questions || await loadQuestions(attempt.examId);
    const ans = answers || attempt.answers || {};
    const score = scoreAttempt(qs, ans, attempt.essayMarks || {});
    const r = await prisma.cBTResult.updateMany({
        where: { id: attempt.id, status: { not: 'SUBMITTED' } },
        data: { status: 'SUBMITTED', answers: ans, ...score, submittedAt: new Date(), submitMethod: method, syncedOffline, clientFinishedAt, lockReason: null },
    });
    if (r.count) {
        const exam = await prisma.exam.findUnique({ where: { id: attempt.examId }, select: { schoolId: true } });
        await logExamEvent({ schoolId: exam.schoolId, examId: attempt.examId, studentProfileId: attempt.studentProfileId, type: 'SUBMITTED', detail: method });
    }
    return prisma.cBTResult.findUnique({ where: { id: attempt.id } });
};

/** Closes every attempt on an exam whose time ran out without the student submitting. */
const sweepExpired = async (examId) => {
    const stale = await prisma.cBTResult.findMany({ where: { examId, status: { in: ['IN_PROGRESS', 'LOCKED'] }, deadlineAt: { lt: new Date(Date.now() - GRACE_MS) } } });
    if (!stale.length) return 0;
    const questions = await loadQuestions(examId);
    for (const a of stale) await finalizeAttempt(a, { questions, method: 'TIMEOUT' });
    return stale.length;
};

/** Should this student be shown their result? Admin release > per-school policy. */
const resultVisible = (exam, cfg, attempt) => {
    if (!attempt || attempt.status !== 'SUBMITTED') return false;
    if (exam.resultRelease === 'RELEASED') return true;
    if (exam.resultRelease === 'HIDDEN') return false;
    return cfg.studentResultVisibility === 'IMMEDIATE';
};

/** What a student is allowed to see about their own result. */
const studentResult = (exam, cfg, attempt, grade, questions) => {
    const total = attempt.objectiveScore + attempt.essayScore;
    const out = {
        examId: exam.id, title: exam.title, score: Math.round(total * 10) / 10, maxScore: attempt.maxScore, percentage: attempt.totalScore,
        grade: grade.grade, remark: grade.remark, passed: attempt.totalScore >= exam.passingMarks, pending: attempt.markingStatus === 'PENDING', submittedAt: attempt.submittedAt,
    };
    if (cfg.studentSeesBreakdown && questions) {
        out.breakdown = questions.map((q, i) => ({
            number: i + 1, id: q.id, type: q.type, text: q.questionText, options: q.options, marks: q.marks, answer: attempt.answers?.[q.id] ?? null,
            correctAnswer: q.type === 'ESSAY' ? null : q.correctAnswer,
            score: q.type === 'ESSAY' ? (attempt.essayMarks?.[q.id]?.score ?? null) : attempt.itemScores?.[q.id] ?? 0,
            comment: attempt.essayMarks?.[q.id]?.comment || null, explanation: q.explanation,
        }));
    }
    return out;
};

/** The exam as the student's browser receives it: ordered per student, with no answers. */
const buildExamPayload = ({ exam, questions, attempt, cfg, serverNow = new Date() }) => {
    let list = questions;
    if (exam.shuffleQuestions) list = shuffled(list, attempt.id);
    const qs = list.map((q, i) => {
        let options = q.type === 'MULTIPLE_CHOICE' ? q.options : null;
        if (options && exam.shuffleOptions) options = shuffled(options, `${attempt.id}:${q.id}`);
        return { id: q.id, number: i + 1, type: q.type, text: q.questionText, options, marks: q.marks };
    });
    const s = exam.settings || {};
    return {
        attemptId: attempt.id, serverNow: serverNow.toISOString(), startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt, answers: attempt.answers || {},
        exam: {
            id: exam.id, title: exam.title, instructions: exam.instructions || '', durationMinutes: exam.durationMinutes + (attempt.extraMinutes || 0),
            subjectName: exam.subject?.name, className: exam.class?.name, totalMarks: qs.reduce((n, q) => n + q.marks, 0),
            warnAtMinutes: s.warnAtMinutes ?? cfg.warnAtMinutes, allowBackNav: s.allowBackNav ?? cfg.allowBackNav, disableCopyPaste: s.disableCopyPaste ?? cfg.disableCopyPaste,
            offline: cfg.offlineEnabled, graceSeconds: GRACE_MS / 1000,
        },
        questions: qs,
    };
};

/**
 * Login guard: a student who is mid-exam on one device can't sign in from another.
 * Returns the blocking attempt (or null). A device that never started the exam, or an attempt whose time has
 * run out, doesn't block.
 */
const findBlockingAttempt = async (studentProfileId, deviceId) => {
    const live = await prisma.cBTResult.findMany({
        where: { studentProfileId, status: { in: ['IN_PROGRESS', 'LOCKED'] }, deviceId: { not: null }, deadlineAt: { gt: new Date(Date.now() - GRACE_MS) } },
        include: { exam: { select: { id: true, title: true, schoolId: true } } },
    });
    return live.find(a => a.deviceId !== deviceId) || null;
};

/** A second device tried to sign in during the exam: log it and (by policy) lock the attempt until an admin releases it. */
const lockForSecondDevice = async (attempt, cfg) => {
    await logExamEvent({ schoolId: attempt.exam.schoolId, examId: attempt.examId, studentProfileId: attempt.studentProfileId, type: 'DEVICE_CONFLICT', detail: 'Sign-in attempt from a different device' });
    if (cfg.lockOnSecondDevice && attempt.status === 'IN_PROGRESS') {
        await prisma.cBTResult.update({ where: { id: attempt.id }, data: { status: 'LOCKED', lockReason: 'Someone tried to sign in to this account from another device' } });
        await logExamEvent({ schoolId: attempt.exam.schoolId, examId: attempt.examId, studentProfileId: attempt.studentProfileId, type: 'LOCKED', detail: 'Second device sign-in' });
    }
};

module.exports = {
    lockForSecondDevice, GRACE_MS, CLIENT_CLOCK_TOLERANCE_MS, logExamEvent, loadQuestions, isExpired, finalizeAttempt, sweepExpired, resultVisible, studentResult, buildExamPayload, findBlockingAttempt,
};
