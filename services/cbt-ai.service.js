const prisma = require('../db/prisma');
const { callGemini } = require('./academic-ai.service');
const { normalizeQuestion, plainFromHtml, KEYS } = require('./cbt-content.service');

const today = () => new Date().toISOString().slice(0, 10);
const getUsage = async (userId) => (await prisma.cbtAiUsage.findUnique({ where: { userId_day: { userId, day: today() } } }))?.count || 0;
const bumpUsage = (userId) => prisma.cbtAiUsage.upsert({ where: { userId_day: { userId, day: today() } }, update: { count: { increment: 1 } }, create: { userId, day: today(), count: 1 } });

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const parseJson = (raw) => {
    const t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(t); } catch { /* try to salvage the outermost object / array */ }
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw bad('The AI response could not be read. Try again.', 502);
};

const FORMAT = `Return ONLY a JSON object: {"questions":[ ... ]} — no markdown, no commentary. Each question:
{
  "type": "MULTIPLE_CHOICE" | "TRUE_FALSE" | "FILL_BLANK" | "ESSAY",
  "question": "HTML fragment for the question (no <html>/<body>; use <p>, <strong>, <em>, <sub>, <sup>, <br>)",
  "options": ["option 1 HTML", "option 2 HTML", ...]   // MULTIPLE_CHOICE only, 4 options unless told otherwise, WITHOUT letter prefixes
  "answer": "A" | "B"... for MULTIPLE_CHOICE (letter of the correct option); "TRUE" or "FALSE" for TRUE_FALSE; the accepted answer(s) separated by | for FILL_BLANK; a short marking guide for ESSAY,
  "marks": number,
  "topic": "short topic label",
  "difficulty": "EASY" | "MEDIUM" | "HARD",
  "explanation": "one or two sentences explaining the answer"
}
FORMULAS: write every mathematical, physical or chemical formula as LaTeX inside an empty span, e.g. <span data-math="\\\\frac{a}{b} + \\\\sqrt{x}"></span> (use data-display="true" for a formula on its own line). Never use $...$ in the output. Chemical formulas: <span data-math="\\\\mathrm{H_2O}"></span>.`;

const buildGeneratePrompt = (i, cfg) => {
    const diagrams = (i.includeDiagrams ?? cfg.includeDiagrams) && Number(cfg.maxDiagrams) > 0;
    const mix = Object.entries(i.mix || {}).filter(([, n]) => Number(n) > 0).map(([t, n]) => `${n} × ${t}`).join(', ');
    return `You are an experienced examiner writing questions for a computer-based test.
Write the following questions: ${mix}.
Subject: ${i.subject || 'General'}
Class / level: ${i.level || 'not specified'}
Topic / scope: ${i.topic || 'general syllabus coverage'}
Difficulty: ${i.difficulty || 'MIXED (mostly medium)'}
Curriculum / standard: ${i.curriculum || cfg.defaultCurriculum}
Language: ${i.language || cfg.language}
${i.instructions ? `\nTeacher's extra instructions:\n${i.instructions}` : ''}${cfg.extraAiInstructions ? `\nSchool-wide guidance (always follow):\n${cfg.extraAiInstructions}` : ''}
${i.sourceText ? `\nBase the questions ONLY on this material:\n"""\n${String(i.sourceText).slice(0, 12000)}\n"""\n` : ''}
QUALITY
- Accurate, unambiguous, age-appropriate questions with exactly one defensible correct answer. Distractors must be plausible. Vary which letter is correct. Do not repeat questions.
- Essay marks should reflect the work expected (typically 5–15); objective questions are 1 mark unless the question is multi-step.
${diagrams
        ? `- DIAGRAMS: where a figure genuinely helps (geometry, graphs, circuits, biology/geography drawings, number lines…), you may embed up to ${Math.min(Number(cfg.maxDiagrams), 6)} inline SVG diagrams in the question HTML, as <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260" width="100%">…</svg> with clear <text> labels (font-family Arial, size 14+), strong contrast, simple shapes. The diagram must be accurate and must not give away the answer. Do not include a diagram unless it is useful.`
        : '- Do not include diagrams or images.'}

${FORMAT}`;
};

/** Raw model questions → validated drafts (invalid ones are dropped and reported). */
const toDrafts = (list, defaults = {}) => {
    const drafts = []; const skipped = [];
    (Array.isArray(list) ? list : []).forEach((r, idx) => {
        try {
            const type = String(r.type || '').toUpperCase().replace(/[\s-]/g, '_');
            const rawOpts = (Array.isArray(r.options) ? r.options : []).map((o, i) => ({ key: KEYS[i], text: typeof o === 'string' ? o : o?.text }));
            const n = normalizeQuestion({
                type, questionText: r.question ?? r.questionText, options: rawOpts, correctAnswer: r.answer ?? r.correctAnswer,
                marks: r.marks ?? (type === 'ESSAY' ? 10 : 1), explanation: r.explanation, topic: r.topic || defaults.topic, difficulty: r.difficulty || defaults.difficulty,
            });
            drafts.push({ ...n, number: drafts.length + 1, warnings: [] });
        } catch (e) { skipped.push(`#${idx + 1}: ${e.message}`); }
    });
    return { drafts, skipped };
};

const generateQuestions = async (input, cfg) => {
    const total = Object.values(input.mix || {}).reduce((a, n) => a + (Number(n) || 0), 0);
    if (!total) throw bad('Say how many questions of each type you want.');
    if (total > cfg.maxAiQuestionsPerRequest) throw bad(`You can generate at most ${cfg.maxAiQuestionsPerRequest} questions at a time.`);
    if (!input.topic?.trim() && !input.sourceText?.trim() && !input.instructions?.trim()) throw bad('Give a topic, paste some source material, or describe what to test.');
    const raw = await callGemini(buildGeneratePrompt(input, cfg), { json: true, temperature: 0.8 });
    const data = parseJson(raw);
    const { drafts, skipped } = toDrafts(Array.isArray(data) ? data : data.questions, { topic: input.topic, difficulty: input.difficulty && input.difficulty !== 'MIXED' ? input.difficulty : undefined });
    if (!drafts.length) throw bad('The AI did not return usable questions. Try again or adjust the request.', 502);
    return { drafts, skipped };
};

/** Messy pasted / extracted text → structured questions, for when the rule-based splitter is not enough. */
const structureText = async (text, cfg) => {
    const prompt = `Below is raw text copied from an exam paper (possibly with numbering, options, answers, section headers and OCR noise). Extract EVERY question exactly as written — do not invent, reword or add questions. Keep the original wording. If an answer key is present, use it; if no answer is given for an objective question, make your best determination of the correct answer.
Infer each question's type (options → MULTIPLE_CHOICE; True/False → TRUE_FALSE; blank to fill → FILL_BLANK; written/theory → ESSAY). Convert formulas to LaTeX as described.

RAW TEXT
"""
${String(text).slice(0, 30000)}
"""

${FORMAT}`;
    const data = parseJson(await callGemini(prompt, { json: true, temperature: 0.1 }));
    const { drafts, skipped } = toDrafts(Array.isArray(data) ? data : data.questions);
    if (!drafts.length) throw bad('No questions could be found in that text.', 422);
    return { drafts, skipped };
};

/** Suggests a mark for an essay answer. The teacher always confirms. */
const suggestEssayMark = async ({ questionHtml, guide, answer, maxMarks }) => {
    const prompt = `You are a fair, consistent examiner. Mark the student's answer.
QUESTION: ${plainFromHtml(questionHtml)}
${guide ? `MARKING GUIDE: ${plainFromHtml(guide)}` : ''}
MAXIMUM MARKS: ${maxMarks}
STUDENT ANSWER: """${String(answer || '').slice(0, 6000)}"""

Award marks for correct, relevant content (partial credit allowed, in steps of 0.5). Return ONLY JSON: {"score": number between 0 and ${maxMarks}, "comment": "one or two sentences telling the student what was good and what was missing"}`;
    const data = parseJson(await callGemini(prompt, { json: true, temperature: 0.2 }));
    const score = Math.min(maxMarks, Math.max(0, Math.round(Number(data.score) * 2) / 2));
    if (!Number.isFinite(score)) throw bad('The AI did not return a mark. Try again.', 502);
    return { score, comment: String(data.comment || '').slice(0, 500) };
};

module.exports = { getUsage, bumpUsage, generateQuestions, structureText, suggestEssayMark, toDrafts };
