const XLSX = require('xlsx');
const { KEYS } = require('./cbt-content.service');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

// ─── plain text → safe HTML, with $formulas$ and ⟦IMG⟧ tokens restored ───────────
const MATH_RE = /\$\$([^$]+?)\$\$|\\\[([^\]]+?)\\\]|\\\(([^)]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
const looksLikeMoney = (s) => /^\d[\d,.]*(\s|$)/.test(s) && !/[\\^_=+\-*/{}]/.test(s.replace(/^\d[\d,.]*/, ''));

const textToHtml = (text, images = []) => {
    const lines = String(text || '').split('\n').map(l => l.trimEnd());
    const html = lines.filter(l => l.trim() !== '').map(line => {
        let out = '', last = 0;
        line.replace(MATH_RE, (m, d1, d2, d3, inline, idx) => {
            const latex = (d1 ?? d2 ?? d3 ?? inline).trim();
            if (inline !== undefined && looksLikeMoney(latex)) return m;
            out += esc(line.slice(last, idx));
            out += `<span data-math="${escAttr(latex)}"${d1 !== undefined || d2 !== undefined ? ' data-display="true"' : ''}></span>`;
            last = idx + m.length;
            return m;
        });
        out += esc(line.slice(last));
        return out.replace(/⟦IMG(\d+)⟧/g, (m, n) => images[Number(n)] || '');
    });
    return html.length > 1 ? html.map(h => `<p>${h}</p>`).join('') : `<p>${html[0] || ''}</p>`;
};

// ─── rule-based question splitter ─────────────────────────────────────────────
const Q_START = /^\s*(?:Q(?:uestion)?\.?\s*(\d{1,3})\s*[.):\-]?|(\d{1,3})\s*[.):\-])(?:\s+(.*))?$/i;
const OPT_LINE = /^\s*\(?([A-Ha-h])[.):]\s+(.*)$/;
const OPT_INLINE = /(?:^|\s)\(?([A-Ha-h])[.)]\s+/g;
const ANS_LINE = /^\s*(?:correct\s+)?(?:ans(?:wer)?|key|correct(?:\s+answer)?)\s*(?:is)?\s*[:\-=]\s*(.+?)\s*$/i;
const EXPL_LINE = /^\s*(?:explanation|solution|reason|working)\s*[:\-]\s*(.*)$/i;
const MARKS_RE = /[[(]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mks?|pts?|points?)\s*[\])]|\bmarks?\s*[:=]\s*(\d+)/i;
const KEY_HEADER = /^\s*(?:answers?(?:\s+key)?|answer\s+sheet|marking\s+scheme\s+for\s+objectives?|key)\s*[:\-]?\s*$/i;
const KEY_PAIR = /(\d{1,3})\s*[.):\-=]?\s*\(?([A-Ha-h])\)?(?=[\s,;.]|$)/g;
const SECTION = /^\s*(?:Section|SECTION|Part|PART)\s+(?:[A-Z]|\d{1,2}|[IVX]+)\b.{0,80}$/;

/** "B", "(b)", "B." and "B. Abuja" all mean option B; anything else is the answer text itself. */
const answerValue = (raw) => {
    const t = String(raw).trim();
    const m = /^\(?([A-Ha-h])\)?[.)]?$/.exec(t) || /^\(?([A-Ha-h])[.)]\s+\S/.exec(t);
    return m ? m[1].toUpperCase() : t;
};

/** Splits "A. x  B. y  C. z" that was typed on a single line into separate option lines. */
const explodeInlineOptions = (line) => {
    const marks = [...line.matchAll(OPT_INLINE)];
    if (marks.length < 2 || marks[0][1].toUpperCase() !== 'A') return null;
    const parts = [];
    const first = marks[0].index + (marks[0][0].startsWith(' ') ? 1 : 0);
    const stem = line.slice(0, first).trim();
    marks.forEach((m, i) => {
        const start = m.index + m[0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
        parts.push({ key: m[1].toUpperCase(), text: line.slice(start, end).trim() });
    });
    return { stem, options: parts };
};

const inferType = (q, sectionType) => {
    if (q.options.length >= 2) return 'MULTIPLE_CHOICE';
    const ans = String(q.answerRaw || '').trim().toUpperCase();
    if (/^(TRUE|FALSE|T|F)$/.test(ans) && (sectionType === 'TRUE_FALSE' || /true\s*(or|\/)\s*false|\btrue\b|\bfalse\b/i.test(q.stem) || sectionType == null)) return 'TRUE_FALSE';
    if (sectionType === 'ESSAY') return 'ESSAY';
    if (/_{2,}|\.{4,}|…{2,}/.test(q.stem) || (q.answerRaw && sectionType === 'FILL_BLANK')) return 'FILL_BLANK';
    if (q.answerRaw) return sectionType === 'MULTIPLE_CHOICE' ? 'MULTIPLE_CHOICE' : 'FILL_BLANK';
    return 'ESSAY';
};

const sectionTypeOf = (line) => {
    const l = line.toLowerCase();
    if (/essay|theory|subjective|long answer|short answer/.test(l)) return 'ESSAY';
    if (/true\s*(or|\/|-)\s*false/.test(l)) return 'TRUE_FALSE';
    if (/fill|blank|gap|completion/.test(l)) return 'FILL_BLANK';
    if (/objective|multiple|choice|mcq/.test(l)) return 'MULTIPLE_CHOICE';
    return null;
};

/**
 * Turns pasted text into draft questions. Handles numbered questions, A–D options (own line or inline),
 * "Answer: B" lines, an answer key at the end ("1. B 2. C…"), marks, explanations, section headers and $LaTeX$.
 * Returns [{ number, type, questionText(html), options, correctAnswer, marks, explanation, warnings }].
 */
const parseQuestionText = (raw, { images = [], defaultMarks = 1 } = {}) => {
    const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    const lines = text.split('\n');

    // separate an answer key block at the end (it would otherwise be read as questions)
    const keyMap = {};
    let keyAt = lines.findIndex(l => KEY_HEADER.test(l));
    if (keyAt === -1) {
        // headerless key: last non-empty lines made only of "1. B 2. C" pairs
        let i = lines.length - 1;
        while (i >= 0 && !lines[i].trim()) i--;
        let j = i;
        while (j >= 0 && (/^\s*(?:\d{1,3}\s*[.):\-=]?\s*\(?[A-Ha-h]\)?[\s,;.]*)+$/.test(lines[j]) || !lines[j].trim())) j--;
        if (i - j >= 1 && [...lines.slice(j + 1).join(' ').matchAll(KEY_PAIR)].length >= 3) keyAt = j + 1;
    }
    let body = lines;
    if (keyAt !== -1) {
        const keyText = lines.slice(keyAt + (KEY_HEADER.test(lines[keyAt]) ? 1 : 0)).join(' ');
        for (const m of keyText.matchAll(KEY_PAIR)) keyMap[Number(m[1])] = m[2].toUpperCase();
        body = lines.slice(0, keyAt);
    }

    const questions = [];
    let cur = null, sectionType = null, mode = 'stem';
    const push = () => { if (cur && (cur.stem.trim() || cur.options.length)) questions.push(cur); cur = null; };

    for (const line of body) {
        if (!line.trim()) { if (cur) cur.blank = true; continue; }
        if (SECTION.test(line)) { sectionType = sectionTypeOf(line) ?? sectionType; push(); continue; }
        if (/^\s*(instructions?|answer\s+all|attempt\s+all)\b/i.test(line) && !cur) continue;

        const qs = Q_START.exec(line);
        const isOpt = OPT_LINE.exec(line);
        if (qs) {
            push();
            cur = { number: Number(qs[1] || qs[2]), stem: qs[3] || '', options: [], answerRaw: '', explanation: '', marks: null, sectionType, blank: false };
            mode = 'stem';
            const mm = cur.stem.match(MARKS_RE);
            if (mm) { cur.marks = Number(mm[1] || mm[2]); cur.stem = cur.stem.replace(MARKS_RE, '').trim(); }
            const ex = explodeInlineOptions(cur.stem);
            if (ex) { cur.stem = ex.stem; cur.options = ex.options; mode = 'opts'; }
            continue;
        }
        if (!cur) { // unnumbered paragraph → a question of its own
            cur = { number: questions.length + 1, stem: '', options: [], answerRaw: '', explanation: '', marks: null, sectionType, blank: false };
        }

        const am = ANS_LINE.exec(line);
        if (am) { cur.answerRaw = answerValue(am[1]); mode = 'ans'; continue; }
        const em = EXPL_LINE.exec(line);
        if (em) { cur.explanation = em[1]; mode = 'expl'; continue; }

        const ex = explodeInlineOptions(line);
        if (ex && mode !== 'expl') { if (ex.stem) cur.stem += (cur.stem ? '\n' : '') + ex.stem; cur.options.push(...ex.options); mode = 'opts'; continue; }
        if (isOpt && mode !== 'expl') {
            cur.options.push({ key: isOpt[1].toUpperCase(), text: isOpt[2].trim() });
            mode = 'opts';
            continue;
        }
        const mm = line.match(MARKS_RE);
        if (mm && mode !== 'opts') { cur.marks = Number(mm[1] || mm[2]); }
        const cleaned = line.replace(MARKS_RE, '').trim();
        if (mode === 'opts' && cur.options.length) cur.options[cur.options.length - 1].text += ` ${cleaned}`; // wrapped option
        else if (mode === 'expl') cur.explanation += `\n${cleaned}`;
        else if (mode === 'ans') cur.answerRaw += ` ${cleaned}`;
        else cur.stem += (cur.stem ? '\n' : '') + cleaned;
    }
    push();

    // Word restarts list numbering, so numbers can repeat; only trust them for the answer key when they are all distinct
    const numbersUnique = new Set(questions.map(q => q.number)).size === questions.length;
    return questions.map((q, idx) => {
        const warnings = [];
        const number = numbersUnique ? (q.number || idx + 1) : idx + 1;
        const type = inferType(q, q.sectionType);
        let correct = (q.answerRaw || keyMap[number] || '').trim();
        let options = null;

        if (type === 'MULTIPLE_CHOICE') {
            options = q.options.map((o, i) => ({ key: KEYS[i], text: textToHtml(o.text, images) }));
            const letter = correct.match(/^[A-Ha-h]$/) ? correct.toUpperCase() : null;
            if (letter) {
                // an option's original letter may differ from its position if the paste skipped one
                const orig = q.options.findIndex(o => o.key === letter);
                correct = orig >= 0 ? KEYS[orig] : letter;
            } else if (correct) {
                const i = q.options.findIndex(o => normalizeLoose(o.text) === normalizeLoose(correct));
                correct = i >= 0 ? KEYS[i] : '';
            }
            if (!correct) warnings.push('No correct answer detected — pick one');
            if (options.length < 2) warnings.push('Fewer than 2 options found');
        } else if (type === 'TRUE_FALSE') {
            const u = correct.toUpperCase();
            correct = u.startsWith('T') ? 'TRUE' : u.startsWith('F') ? 'FALSE' : '';
            if (!correct) warnings.push('Say whether the statement is True or False');
        } else if (type === 'FILL_BLANK') {
            if (!correct) warnings.push('No answer detected for the blank');
        } else {
            correct = '';
        }

        return {
            number, type, questionText: textToHtml(q.stem, images), options,
            correctAnswer: correct || null, marks: q.marks || defaultMarks,
            explanation: q.explanation ? textToHtml(q.explanation, images) : null, warnings,
        };
    }).filter(q => q.questionText.replace(/<[^>]+>/g, '').trim() || /<img/.test(q.questionText));
};

const normalizeLoose = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();

// ─── Word (.docx) → text, keeping images and list numbering ───────────────────
const htmlToLines = (html) => {
    const images = [];
    let h = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
        const src = /src="([^"]+)"/i.exec(tag)?.[1] || '';
        if (!/^data:image\//i.test(src) || src.length > 400000) return ' ';
        images.push(`<img src="${src}" alt="" />`);
        return `⟦IMG${images.length - 1}⟧`;
    });
    // number list items: ordered lists → 1. 2. 3. at the top level, a. b. c. when nested
    const out = []; const stack = []; let buf = '';
    const flush = () => { if (buf.trim()) out.push(buf.replace(/\s+/g, ' ').trim()); buf = ''; };
    const tok = h.split(/(<\/?(?:ol|ul|li|p|br|tr|h[1-6]|div|table)\b[^>]*>)/gi);
    for (const t of tok) {
        const m = /^<(\/?)(ol|ul|li|p|br|tr|h[1-6]|div|table)\b/i.exec(t);
        if (!m) { buf += t.replace(/<[^>]+>/g, ''); continue; }
        const closing = !!m[1], name = m[2].toLowerCase();
        if (name === 'ol' || name === 'ul') { flush(); if (closing) stack.pop(); else stack.push({ ordered: name === 'ol', n: 0 }); continue; }
        if (name === 'li') {
            flush();
            if (!closing && stack.length) {
                const top = stack[stack.length - 1]; top.n++;
                if (top.ordered) buf += stack.length === 1 ? `${top.n}. ` : `${String.fromCharCode(96 + top.n)}. `;
            }
            continue;
        }
        flush();
    }
    flush();
    const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return { text: decode(out.join('\n')), images };
};

const fromDocx = async (buffer) => {
    const mammoth = require('mammoth');
    const r = await mammoth.convertToHtml({ buffer }, {
        convertImage: mammoth.images.imgElement(async (image) => {
            const b64 = await image.read('base64');
            return { src: `data:${image.contentType};base64,${b64}` };
        }),
    });
    const { text, images } = htmlToLines(r.value);
    return { text, images, note: images.length ? null : null };
};

const fromPdf = async (buffer) => {
    const pdfParse = require('pdf-parse');
    // the default bundled pdf.js (1.10.100) chokes on PDFs written by Chrome and many modern tools; try newer builds first
    let r, lastError;
    for (const version of ['v2.0.550', 'v1.10.88', 'v1.10.100']) {
        try { r = await pdfParse(buffer, { version }); break; } catch (e) { lastError = e; }
    }
    if (!r) throw lastError;
    return { text: r.text || '', images: [], note: 'Images and diagrams inside a PDF can’t be extracted — add them to each question after importing.' };
};

// ─── Excel / CSV ──────────────────────────────────────────────────────────────
const HEADER_ALIASES = {
    question: ['question', 'questions', 'q', 'text', 'question text', 'stem'],
    type: ['type', 'question type', 'qtype'],
    answer: ['answer', 'correct', 'correct answer', 'key', 'ans', 'correct option'],
    marks: ['marks', 'mark', 'score', 'points'],
    topic: ['topic', 'subtopic', 'unit'],
    difficulty: ['difficulty', 'level'],
    explanation: ['explanation', 'solution', 'reason'],
};
const OPTION_HEADER = /^(?:option\s*)?([a-h])$|^option\s*([1-8])$/i;

const TYPE_WORDS = {
    MULTIPLE_CHOICE: /^(mcq|multiple|objective|choice|multiple[\s_-]*choice|obj)/i,
    TRUE_FALSE: /^(true|tf|t\/f|boolean)/i,
    FILL_BLANK: /^(fill|blank|short|gap|completion|cloze)/i,
    ESSAY: /^(essay|theory|long|subjective|descriptive)/i,
};

const fromSheet = (buffer) => {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (rows.length < 2) return [];
    const header = rows[0].map(h => String(h).trim().toLowerCase());
    const col = {}; const optCols = [];
    header.forEach((h, i) => {
        for (const [k, names] of Object.entries(HEADER_ALIASES)) if (names.includes(h) && col[k] === undefined) col[k] = i;
        const om = OPTION_HEADER.exec(h);
        if (om) optCols.push({ i, idx: om[1] ? om[1].toUpperCase().charCodeAt(0) - 65 : Number(om[2]) - 1 });
    });
    if (col.question === undefined) throw Object.assign(new Error('Could not find a "Question" column. Download the template to see the expected layout.'), { status: 400 });
    optCols.sort((a, b) => a.idx - b.idx);

    const out = [];
    rows.slice(1).forEach((r, n) => {
        const stem = String(r[col.question] ?? '').trim();
        if (!stem) return;
        const options = optCols.map(c => String(r[c.i] ?? '').trim()).filter(Boolean);
        const ansRaw = String(r[col.answer] ?? '').trim();
        const typeRaw = String(r[col.type] ?? '').trim();
        let type = Object.keys(TYPE_WORDS).find(k => TYPE_WORDS[k].test(typeRaw));
        if (!type) type = options.length >= 2 ? 'MULTIPLE_CHOICE' : /^(true|false)$/i.test(ansRaw) ? 'TRUE_FALSE' : ansRaw ? 'FILL_BLANK' : 'ESSAY';

        const warnings = []; let correct = ansRaw; let opts = null;
        if (type === 'MULTIPLE_CHOICE') {
            opts = options.map((t, i) => ({ key: KEYS[i], text: textToHtml(t) }));
            if (/^[A-Ha-h]$/.test(correct)) correct = correct.toUpperCase();
            else if (/^\d$/.test(correct) && Number(correct) >= 1 && Number(correct) <= options.length) correct = KEYS[Number(correct) - 1];
            else { const i = options.findIndex(o => normalizeLoose(o) === normalizeLoose(correct)); correct = i >= 0 ? KEYS[i] : ''; }
            if (!correct) warnings.push('Correct answer missing or not matching an option');
            if (opts.length < 2) warnings.push('Fewer than 2 options');
        } else if (type === 'TRUE_FALSE') {
            correct = /^t/i.test(correct) ? 'TRUE' : /^f/i.test(correct) ? 'FALSE' : '';
            if (!correct) warnings.push('Answer must be True or False');
        } else if (type === 'ESSAY') correct = '';
        else if (!correct) warnings.push('No answer given for the blank');

        out.push({
            number: n + 1, type, questionText: textToHtml(stem), options: opts, correctAnswer: correct || null,
            marks: Number(r[col.marks]) > 0 ? Number(r[col.marks]) : 1,
            topic: String(r[col.topic] ?? '').trim() || null,
            difficulty: String(r[col.difficulty] ?? '').trim().toUpperCase() || 'MEDIUM',
            explanation: String(r[col.explanation] ?? '').trim() ? textToHtml(String(r[col.explanation])) : null,
            warnings,
        });
    });
    return out;
};

const buildTemplate = () => {
    const rows = [
        ['Question', 'Type', 'A', 'B', 'C', 'D', 'E', 'Answer', 'Marks', 'Topic', 'Difficulty', 'Explanation'],
        ['What is the capital of Nigeria?', 'MCQ', 'Lagos', 'Abuja', 'Kano', 'Ibadan', '', 'B', 1, 'Geography', 'EASY', 'Abuja replaced Lagos in 1991.'],
        ['Solve $2x + 6 = 14$.', 'MCQ', '2', '3', '4', '5', '', 'C', 2, 'Algebra', 'MEDIUM', ''],
        ['The sun rises in the west.', 'True/False', '', '', '', '', '', 'False', 1, 'Science', 'EASY', ''],
        ['The chemical symbol for water is ______.', 'Fill in the blank', '', '', '', '', '', 'H2O|H₂O', 1, 'Chemistry', 'EASY', ''],
        ['Explain the process of photosynthesis.', 'Essay', '', '', '', '', '', '', 10, 'Biology', 'HARD', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 48 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 34 }];
    const help = XLSX.utils.aoa_to_sheet([
        ['How to fill this sheet'],
        ['• One question per row. Keep the header row exactly as it is.'],
        ['• Type: MCQ, True/False, Fill in the blank or Essay. Leave empty and it is worked out from the other columns.'],
        ['• Answer: the letter of the correct option (A–E) for MCQ; True or False; or the accepted answer for a blank (separate alternatives with |). Leave empty for essays.'],
        ['• Formulas: wrap LaTeX in dollar signs, e.g. $x^2 + 3x - 4 = 0$ or $\\frac{a}{b}$.'],
        ['• Images and diagrams can be added to each question after importing.'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    XLSX.utils.book_append_sheet(wb, help, 'Help');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

module.exports = { parseQuestionText, textToHtml, fromDocx, fromPdf, fromSheet, buildTemplate, htmlToLines };
