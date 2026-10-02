const sanitizeHtml = require('sanitize-html');
const { SANITIZE_OPTIONS } = require('./academic-ai.service');

const QUESTION_TYPES = ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_BLANK', 'ESSAY'];
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const OBJECTIVE_TYPES = ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_BLANK'];
const KEYS = 'ABCDEFGH'.split('');

// ─── school-wide CBT policy (admin controlled; mirrors the lesson-note config pattern) ──
const DEFAULT_CONFIG = {
    // AI
    teacherAiEnabled: true,
    teacherDailyAiLimit: 20,
    maxAiQuestionsPerRequest: 30,
    includeDiagrams: true,
    maxDiagrams: 3,
    defaultCurriculum: 'Nigerian (NERDC / Universal Basic Education)',
    language: 'English',
    extraAiInstructions: '',
    // Authoring
    teacherCanUpload: true,
    maxUploadMB: 10,
    requireTermSession: true,
    // What teachers may change (admin always can)
    teacherCanEditTimer: true,
    teacherCanAddTime: true,
    teacherCanExempt: true,
    teacherCanMarkEssays: true,
    // Exam defaults
    defaultDurationMinutes: 60,
    defaultPassMark: 40,
    warnAtMinutes: 5,
    shuffleQuestions: false,
    shuffleOptions: false,
    allowBackNav: true,
    disableCopyPaste: false,
    // Offline
    offlineEnabled: true,
    offlineSyncWindowHours: 24,
    // Security
    singleDeviceLock: true,
    lockOnSecondDevice: true,
    // Results
    studentResultVisibility: 'HIDDEN', // HIDDEN | IMMEDIATE — per-exam release by the admin always wins
    studentSeesBreakdown: false,
    // Printed / exported results
    includeLetterhead: true,
    letterheadText: '',
    footerText: '',
    pageSize: 'A4',
    fontFamily: 'Arial',
    fontSizePt: 10,
};

const mergeConfig = (saved) => ({ ...DEFAULT_CONFIG, ...(saved || {}) });

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** Clamp / coerce an admin-submitted config so a bad payload can never break the exam engine. */
const cleanConfig = (b = {}) => {
    const d = DEFAULT_CONFIG;
    return mergeConfig({
        ...Object.fromEntries(Object.keys(d).filter(k => typeof d[k] === 'boolean').map(k => [k, bool(b[k], d[k])])),
        teacherDailyAiLimit: num(b.teacherDailyAiLimit, 0, 500, d.teacherDailyAiLimit),
        maxAiQuestionsPerRequest: num(b.maxAiQuestionsPerRequest, 1, 60, d.maxAiQuestionsPerRequest),
        maxDiagrams: num(b.maxDiagrams, 0, 10, d.maxDiagrams),
        maxUploadMB: num(b.maxUploadMB, 1, 20, d.maxUploadMB),
        defaultDurationMinutes: num(b.defaultDurationMinutes, 1, 600, d.defaultDurationMinutes),
        defaultPassMark: num(b.defaultPassMark, 0, 100, d.defaultPassMark),
        warnAtMinutes: num(b.warnAtMinutes, 0, 60, d.warnAtMinutes),
        offlineSyncWindowHours: num(b.offlineSyncWindowHours, 1, 168, d.offlineSyncWindowHours),
        fontSizePt: num(b.fontSizePt, 8, 16, d.fontSizePt),
        studentResultVisibility: b.studentResultVisibility === 'IMMEDIATE' ? 'IMMEDIATE' : 'HIDDEN',
        pageSize: b.pageSize === 'Letter' ? 'Letter' : 'A4',
        fontFamily: String(b.fontFamily || d.fontFamily).slice(0, 40),
        defaultCurriculum: String(b.defaultCurriculum || d.defaultCurriculum).slice(0, 120),
        language: String(b.language || d.language).slice(0, 40),
        extraAiInstructions: String(b.extraAiInstructions || '').slice(0, 2000),
        letterheadText: String(b.letterheadText || '').slice(0, 200),
        footerText: String(b.footerText || '').slice(0, 200),
    });
};

// ─── sanitising: academic sanitiser (HTML, tables, images, SVG) plus formula spans ───
const CBT_SANITIZE = {
    ...SANITIZE_OPTIONS,
    allowedAttributes: { ...SANITIZE_OPTIONS.allowedAttributes, span: ['style', 'data-math', 'data-display'] },
};
const sanitize = (html) => sanitizeHtml(String(html ?? ''), CBT_SANITIZE);

const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
/** True when the HTML shows something: text, an image, a diagram or a formula. */
const hasContent = (html) => !!stripTags(html) || /<(img|svg)[\s>]|data-math=/i.test(html || '');

const plainFromHtml = (html) => stripTags(String(html || '').replace(/<span[^>]*data-math="([^"]*)"[^>]*><\/span>/g, ' $1 '));

// ─── question validation / normalisation ───────────────────────────────────────
class QuestionError extends Error {}

const normalizeQuestion = (q) => {
    const type = QUESTION_TYPES.includes(q.type) ? q.type : null;
    if (!type) throw new QuestionError('Choose a valid question type');
    const questionText = sanitize(q.questionText);
    if (!hasContent(questionText)) throw new QuestionError('The question is empty');

    let options = null;
    let correctAnswer = q.correctAnswer == null ? null : String(q.correctAnswer).trim();

    if (type === 'MULTIPLE_CHOICE') {
        const raw = (Array.isArray(q.options) ? q.options : []).filter(o => o && hasContent(sanitize(o.text ?? o)));
        if (raw.length < 2) throw new QuestionError('A multiple-choice question needs at least 2 options');
        if (raw.length > KEYS.length) throw new QuestionError(`At most ${KEYS.length} options are allowed`);
        // re-key A, B, C… in order, remembering which original key was marked correct
        const origKeys = raw.map((o, i) => String(o.key || KEYS[i]).toUpperCase());
        options = raw.map((o, i) => ({ key: KEYS[i], text: sanitize(o.text ?? o) }));
        const idx = origKeys.indexOf(String(correctAnswer || '').toUpperCase());
        if (idx === -1) throw new QuestionError('Mark which option is correct');
        correctAnswer = KEYS[idx];
    } else if (type === 'TRUE_FALSE') {
        const v = String(correctAnswer || '').toUpperCase();
        if (v !== 'TRUE' && v !== 'FALSE') throw new QuestionError('Mark whether the statement is True or False');
        correctAnswer = v;
    } else if (type === 'FILL_BLANK') {
        correctAnswer = String(correctAnswer || '').split('|').map(s => s.trim()).filter(Boolean).join('|');
        if (!correctAnswer) throw new QuestionError('Give the accepted answer for the blank (separate alternatives with |)');
    } else {
        correctAnswer = correctAnswer ? sanitize(correctAnswer) : null; // marking guide for essays — never shown to students
    }

    const explanation = q.explanation ? sanitize(q.explanation) : null;
    const marks = Math.round(num(q.marks, 1, 100, 1));
    const difficulty = DIFFICULTIES.includes(String(q.difficulty).toUpperCase()) ? String(q.difficulty).toUpperCase() : 'MEDIUM';
    const tags = (Array.isArray(q.tags) ? q.tags : []).map(t => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 10);
    const topic = q.topic ? String(q.topic).trim().slice(0, 120) : null;
    const sizeBytes = Buffer.byteLength(questionText + JSON.stringify(options || '') + (explanation || '') + (correctAnswer || ''), 'utf8');

    return { type, questionText, options, correctAnswer, explanation, marks, difficulty, tags, topic, sizeBytes };
};

// ─── auto-marking ─────────────────────────────────────────────────────────────
const normText = (s) => String(s ?? '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[\s ]+/g, ' ').trim().replace(/[.,;:!?]+$/g, '').trim();
const asNumber = (s) => {
    const t = String(s).replace(/[,\s]/g, '');
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/** Marks one objective answer. Returns the score earned (0 or the question's marks), or null for essays. */
const markObjective = (q, answer) => {
    if (q.type === 'ESSAY') return null;
    if (answer == null || String(answer).trim() === '') return 0;
    if (q.type === 'MULTIPLE_CHOICE' || q.type === 'TRUE_FALSE') {
        return String(answer).trim().toUpperCase() === String(q.correctAnswer || '').trim().toUpperCase() ? q.marks : 0;
    }
    // FILL_BLANK: any accepted alternative, ignoring case/spacing/trailing punctuation; numbers compare as numbers
    const given = normText(answer);
    const givenNum = asNumber(given);
    const ok = String(q.correctAnswer || '').split('|').some(alt => {
        const a = normText(alt);
        if (a === given) return true;
        const an = asNumber(a);
        return an !== null && givenNum !== null && an === givenNum;
    });
    return ok ? q.marks : 0;
};

/**
 * Totals an attempt. `questions` are the exam's question rows, `answers` the student's answers and
 * `essayMarks` the teacher's marks. Essays with a non-blank answer and no mark keep the attempt PENDING.
 */
const scoreAttempt = (questions, answers = {}, essayMarks = {}) => {
    const itemScores = {};
    let objective = 0, essay = 0, max = 0, pending = false;
    for (const q of questions) {
        max += q.marks;
        if (q.type === 'ESSAY') {
            const m = essayMarks?.[q.id];
            if (m && Number.isFinite(Number(m.score))) {
                const s = Math.min(q.marks, Math.max(0, Number(m.score)));
                essay += s;
            } else if (String(answers?.[q.id] ?? '').trim()) pending = true;
            continue;
        }
        const s = markObjective(q, answers?.[q.id]);
        itemScores[q.id] = s;
        objective += s;
    }
    const total = objective + essay;
    return {
        itemScores, objectiveScore: objective, essayScore: essay, maxScore: max,
        totalScore: max > 0 ? Math.round((total / max) * 1000) / 10 : 0,
        markingStatus: pending ? 'PENDING' : 'COMPLETE',
    };
};

// ─── per-student ordering (deterministic, so a resumed attempt keeps its order) ───
const seeded = (seedStr) => {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => {
        h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    };
};
const shuffled = (arr, seed) => {
    const rand = seeded(seed); const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
};

module.exports = {
    QUESTION_TYPES, DIFFICULTIES, OBJECTIVE_TYPES, KEYS, DEFAULT_CONFIG, mergeConfig, cleanConfig,
    sanitize, stripTags, hasContent, plainFromHtml, QuestionError, normalizeQuestion, markObjective, scoreAttempt, shuffled,
};
