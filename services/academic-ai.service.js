const axios = require('axios');
const sanitizeHtml = require('sanitize-html');
const prisma = require('../db/prisma');

const DOC_TYPES = ['LESSON_NOTE', 'LESSON_PLAN', 'SCHEME_OF_WORK', 'CURRICULUM', 'CUSTOM'];

const CURRICULA = [
    'Nigerian (NERDC / Universal Basic Education)', 'Nigerian (WAEC / NECO senior secondary syllabus)', 'Nigerian Nursery & Primary (NERDC)',
    'British National Curriculum (England)', 'Cambridge Primary / IGCSE / A-Level', 'American (Common Core)', 'International Baccalaureate (PYP / MYP / DP)',
    'Ghanaian (GES)', 'Kenyan (CBC)', 'South African (CAPS)', 'Islamic / Arabic school curriculum', 'Montessori', 'Custom (describe in the instructions)',
];

const DEFAULT_CONFIG = {
    defaultCurriculum: 'Nigerian (NERDC / Universal Basic Education)',
    language: 'English',
    weeksPerTerm: 13,
    defaultDuration: '40 minutes',
    detailLevel: 'standard', // concise | standard | detailed
    includeDiagrams: true,
    maxDiagrams: 2,
    lessonNoteSections: [
        'Subject, Class, Topic, Duration, Week/Term/Session', 'Previous knowledge', 'Behavioural objectives', 'Instructional materials',
        'Introduction (set induction)', 'Presentation (steps with teacher\'s and learners\' activities)', 'Evaluation', 'Summary / board summary', 'Assignment', 'References',
    ],
    extraAiInstructions: '', // school-wide guidance appended to every AI request
    teacherAiEnabled: true,
    teacherDailyAiLimit: 20,
    teacherCanUpload: true,
    maxUploadMB: 10,
    requireTermWeek: true,
    includeLetterhead: true,
    letterheadText: '',
    footerText: '',
    pageSize: 'A4', // A4 | Letter
    fontFamily: 'Arial',
    fontSizePt: 11,
    customCurricula: [],
};

const mergeConfig = (saved) => ({ ...DEFAULT_CONFIG, ...(saved || {}) });

// ─── sanitising (AI output and user-edited HTML, incl. inline SVG diagrams) ──
const SVG_TAGS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'clipPath', 'use', 'pattern'];
const SVG_ATTRS = ['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'fill', 'stroke', 'stroke-width',
    'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
    'marker-end', 'marker-start', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'offset', 'stop-color', 'stop-opacity', 'id', 'gradientUnits', 'x1', 'dx', 'dy', 'rotate', 'clip-path', 'patternUnits', 'style'];
const SAFE_STYLE = /^(?!.*(url\(|expression|javascript:|@import)).*$/i;
const styleProps = ['text-align', 'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-decoration', 'line-height', 'width', 'height', 'min-width', 'max-width',
    'border', 'border-top', 'border-bottom', 'border-left', 'border-right', 'border-collapse', 'border-color', 'border-width', 'border-style', 'padding', 'margin', 'vertical-align', 'list-style-type', 'text-indent', 'display', 'float'];

const SANITIZE_OPTIONS = {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'u', 's', 'sub', 'sup', 'mark', 'hr', 'colgroup', 'col', 'span', 'div', 'caption', ...SVG_TAGS],
    allowedAttributes: {
        '*': ['style', 'align'],
        a: ['href', 'name', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height', 'title'],
        td: ['colspan', 'rowspan', 'style', 'align', 'width'], th: ['colspan', 'rowspan', 'style', 'align', 'width'], col: ['span', 'width'],
        ol: ['start', 'type'],
        ...Object.fromEntries(SVG_TAGS.map(t => [t, SVG_ATTRS])),
    },
    allowedStyles: { '*': Object.fromEntries(styleProps.map(p => [p, [SAFE_STYLE]])) },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false }, // SVG is case-sensitive (viewBox, linearGradient…)
    disallowedTagsMode: 'discard',
};
const sanitize = (html, extra = {}) => sanitizeHtml(String(html || ''), { ...SANITIZE_OPTIONS, ...extra });

// ─── prompt building ─────────────────────────────────────────────────────────
const DOC_SPEC = {
    LESSON_NOTE: (c, cfg) => `Write a complete, classroom-ready LESSON NOTE.
Use these sections, in this order, each with a clear heading (adapt the wording to the curriculum's conventions):
${cfg.lessonNoteSections.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Open with a compact table giving subject, class, topic, duration, week, term and session. The presentation must be a table or numbered steps showing teacher activity, learner activity and (where useful) timing.`,
    LESSON_PLAN: () => `Write a complete LESSON PLAN in the style used by the chosen curriculum (for British-style curricula: learning objectives, success criteria, starter, main activities with differentiation, plenary, assessment for learning, resources, homework). Open with a compact details table.`,
    SCHEME_OF_WORK: (c, cfg) => `Write a SCHEME OF WORK for ONE TERM covering ${c.weeks || cfg.weeksPerTerm} teaching weeks.
Present it as a table with one row per week: Week | Topic / Unit | Sub-topics | Learning objectives | Teaching & learning activities | Resources | Assessment. Include revision and examination weeks where appropriate. Add a short overview paragraph and a list of references.`,
    CURRICULUM: () => `Write a CURRICULUM document: overview and aims, learning outcomes, units/themes organised term by term (with suggested weeks), skills and competencies, teaching approaches, assessment strategy, resources and references. Use tables for the term-by-term breakdown.`,
    CUSTOM: () => `Produce exactly the document the teacher describes in the request (it may be a worksheet, assessment, marking scheme, rubric, revision pack, unit plan, parent letter, handout, project brief or anything else teaching-related). Choose the best structure for that document.`,
};

const DETAIL = { concise: 'Keep it concise (about 1–2 pages).', standard: 'Give a standard level of detail (about 2–4 pages).', detailed: 'Be thorough and detailed (about 4–8 pages) with fully worked content.' };

const buildPrompt = (input, cfg) => {
    const diagrams = input.includeDiagrams ?? cfg.includeDiagrams;
    const maxDiagrams = Math.max(0, Math.min(Number(input.maxDiagrams ?? cfg.maxDiagrams) || 0, 6));
    const spec = (DOC_SPEC[input.docType] || DOC_SPEC.CUSTOM)(input, cfg);
    const meta = [
        input.curriculum && `Curriculum / standard: ${input.curriculum}`,
        input.level && `Class / level: ${input.level}`,
        input.subject && `Subject: ${input.subject}`,
        input.topic && `Topic / scope: ${input.topic}`,
        input.term && `Term: ${input.term}`,
        input.week && `Week: ${input.week}`,
        input.session && `Session: ${input.session}`,
        input.duration && `Lesson duration: ${input.duration}`,
        input.objectives && `Objectives to cover: ${input.objectives}`,
    ].filter(Boolean).join('\n');

    return `You are an expert teacher and curriculum developer. ${spec}

REQUEST DETAILS
${meta || '(none given)'}
${input.prompt ? `\nTeacher's request / extra instructions:\n${input.prompt}` : ''}
${cfg.extraAiInstructions ? `\nSchool-wide guidance (always follow):\n${cfg.extraAiInstructions}` : ''}

QUALITY
- Align content, terminology, assessment style and grade/level conventions to the stated curriculum and the learners' age. Use accurate, current subject content, local examples where relevant, and realistic activities.
- ${DETAIL[input.detailLevel || cfg.detailLevel] || DETAIL.standard}
- Write in ${input.language || cfg.language}.

OUTPUT FORMAT (strict)
- Return ONLY an HTML fragment for the document body: no <html>, <head>, <body>, no markdown, no code fences, no commentary.
- Start with one <h1> containing the document title. Then use <h2>/<h3>, <p>, <ul>/<ol>/<li>, <table> with <thead>/<tbody>/<tr>/<th>/<td> (tables should have clear header rows), <strong>, <em>.
- Do not use CSS classes, <script>, <style>, iframes or external resources.
${diagrams && maxDiagrams
        ? `- DIAGRAMS: where a diagram, chart, map, labelled drawing, flow chart, number line, shape, graph or illustration genuinely helps teaching, include up to ${maxDiagrams} as inline SVG, each wrapped like <figure><svg ...>...</svg><figcaption>Figure N: caption</figcaption></figure>. Each SVG must be self-contained: xmlns="http://www.w3.org/2000/svg", a viewBox (e.g. 0 0 640 400), width="100%", clear <text> labels (font-family Arial, font-size 14+), strong contrast, simple shapes and arrows (define arrow markers inside <defs>), no external images or fonts, nothing outside the viewBox. Make them accurate and neat. Do NOT include a diagram if it would not be accurate or useful.`
        : '- Do not include diagrams or images.'}`;
};

// ─── Gemini call ─────────────────────────────────────────────────────────────
const callGemini = async (prompt, { json = false, temperature = 0.7 } = {}) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        const err = new Error('AI is not configured on the server (GEMINI_API_KEY is missing).');
        err.status = 503;
        throw err;
    }
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    try {
        const r = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature, maxOutputTokens: 32000, thinkingConfig: { thinkingBudget: 1024 }, ...(json && { responseMimeType: 'application/json' }) },
            },
            { headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, timeout: 150000 },
        );
        const cand = r.data?.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
        if (!text.trim()) {
            const err = new Error(r.data?.promptFeedback?.blockReason ? 'The AI declined this request. Try rephrasing it.' : 'The AI returned an empty response. Try again.');
            err.status = 502;
            throw err;
        }
        return text;
    } catch (e) {
        if (e.status) throw e;
        const err = new Error(e.response?.data?.error?.message ? `AI error: ${e.response.data.error.message}` : 'Could not reach the AI service. Try again shortly.');
        err.status = e.response?.status === 429 ? 429 : 502;
        throw err;
    }
};

const cleanModelHtml = (raw) => String(raw)
    .replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '')
    .replace(/<\/?(html|head|body)[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '').trim();

const titleFromHtml = (html, fallback) => {
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const t = m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    return (t || fallback || 'Untitled document').slice(0, 160);
};

// ─── daily limit ─────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const getUsage = async (userId) => (await prisma.academicAiUsage.findUnique({ where: { userId_day: { userId, day: today() } } }))?.count || 0;
const bumpUsage = (userId) => prisma.academicAiUsage.upsert({ where: { userId_day: { userId, day: today() } }, update: { count: { increment: 1 } }, create: { userId, day: today(), count: 1 } });

const generateDocument = async (input, cfg) => {
    if (!DOC_TYPES.includes(input.docType)) throw Object.assign(new Error('Unknown document type'), { status: 400 });
    if (!input.prompt?.trim() && !input.topic?.trim() && input.docType !== 'CURRICULUM') throw Object.assign(new Error('Tell the AI what to write: add a topic or describe the document.'), { status: 400 });
    const html = sanitize(cleanModelHtml(await callGemini(buildPrompt(input, cfg))));
    if (!html) throw Object.assign(new Error('The AI response could not be used. Try again.'), { status: 502 });
    return { html, title: titleFromHtml(html, input.topic || input.subject) };
};

module.exports = { callGemini, SANITIZE_OPTIONS, DOC_TYPES, CURRICULA, DEFAULT_CONFIG, mergeConfig, sanitize, buildPrompt, generateDocument, getUsage, bumpUsage };
