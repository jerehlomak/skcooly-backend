const XLSX = require('xlsx');
const prisma = require('../db/prisma');
const { getBrowser, letterhead, esc } = require('./academic-export.service');

const DEFAULT_GRADES = [
    { grade: 'A', minScore: 75, maxScore: 100, remark: 'Excellent' }, { grade: 'B', minScore: 65, maxScore: 74, remark: 'Very Good' },
    { grade: 'C', minScore: 55, maxScore: 64, remark: 'Good' }, { grade: 'D', minScore: 45, maxScore: 54, remark: 'Pass' },
    { grade: 'E', minScore: 40, maxScore: 44, remark: 'Poor' }, { grade: 'F', minScore: 0, maxScore: 39, remark: 'Fail' },
];

const loadGrades = async (schoolId) => {
    const scale = await prisma.gradingScale.findFirst({ where: { schoolId, category: 'ALL', type: 'SUBJECT', resultType: 'SCORE_BASED', assessmentType: 'EXAM' } });
    return Array.isArray(scale?.grades) && scale.grades.length ? scale.grades : DEFAULT_GRADES;
};

const gradeFor = (pct, grades) => {
    const sorted = [...grades].sort((a, b) => Number(b.minScore) - Number(a.minScore));
    const g = sorted.find(x => pct >= Number(x.minScore) && pct <= Number(x.maxScore)) || sorted.find(x => pct >= Number(x.minScore));
    return g ? { grade: g.grade, remark: g.remark || '' } : { grade: '-', remark: '' };
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Standard competition ranking: equal scores share a position (1, 2, 2, 4…). */
const rank = (rows, valueOf) => {
    const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
    let last = null, pos = 0;
    sorted.forEach((r, i) => { const v = valueOf(r); if (v !== last) { pos = i + 1; last = v; } r.position = pos; });
};

const statusLabel = (attempt, accom) => {
    if (accom?.exempted) return 'Exempted';
    if (!attempt) return 'Absent';
    if (attempt.status === 'IN_PROGRESS') return 'In progress';
    if (attempt.status === 'LOCKED') return 'Locked';
    return 'Submitted';
};

/** One exam: every enrolled student, scored, ranked and graded. */
const buildExamSheet = ({ exam, students, attempts, accommodations, grades }) => {
    const byStudent = new Map(attempts.map(a => [a.studentProfileId, a]));
    const accomBy = new Map(accommodations.map(a => [a.studentProfileId, a]));
    const rows = students.map(s => {
        const a = byStudent.get(s.id); const acc = accomBy.get(s.id);
        const status = statusLabel(a, acc);
        const done = status === 'Submitted';
        const pct = done ? a.totalScore : null;
        return {
            studentProfileId: s.id, name: s.name, admissionNo: s.admissionNo, status,
            objective: done ? a.objectiveScore : null, essay: done ? a.essayScore : null, total: done ? round1(a.objectiveScore + a.essayScore) : null,
            maxScore: done ? a.maxScore : null, percentage: pct, grade: done ? gradeFor(pct, grades).grade : '',
            pending: done && a.markingStatus === 'PENDING', extraMinutes: (a?.extraMinutes || 0), syncedOffline: !!a?.syncedOffline, submittedAt: a?.submittedAt || null,
        };
    });
    rank(rows.filter(r => r.percentage !== null), r => r.percentage);
    const ranked = new Set(rows.filter(r => r.percentage !== null).map(r => r.studentProfileId));
    rows.forEach(r => { if (!ranked.has(r.studentProfileId)) r.position = null; });
    rows.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.no = i + 1; });

    const done = rows.filter(r => r.percentage !== null);
    const pcts = done.map(r => r.percentage);
    return {
        rows,
        stats: {
            enrolled: students.length, submitted: done.length, absent: rows.filter(r => r.status === 'Absent').length,
            exempted: rows.filter(r => r.status === 'Exempted').length, inProgress: rows.filter(r => r.status === 'In progress' || r.status === 'Locked').length,
            average: pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0,
            highest: pcts.length ? Math.max(...pcts) : 0, lowest: pcts.length ? Math.min(...pcts) : 0,
            passRate: pcts.length ? round1((pcts.filter(p => p >= exam.passingMarks).length / pcts.length) * 100) : 0,
            pendingMarking: done.filter(r => r.pending).length,
        },
    };
};

/** A class across several exams: students down the side, one column per exam. */
const buildMasterSheet = ({ exams, students, attempts, accommodations, grades }) => {
    const key = (e, s) => `${e}|${s}`;
    const att = new Map(attempts.map(a => [key(a.examId, a.studentProfileId), a]));
    const acc = new Map(accommodations.map(a => [key(a.examId, a.studentProfileId), a]));
    const rows = students.map(s => {
        const scores = exams.map(e => {
            const a = att.get(key(e.id, s.id)); const x = acc.get(key(e.id, s.id));
            if (x?.exempted) return { status: 'Exempted' };
            if (!a || a.status !== 'SUBMITTED') return { status: a ? 'Incomplete' : 'Absent' };
            return { status: 'Submitted', percentage: a.totalScore, score: round1(a.objectiveScore + a.essayScore), maxScore: a.maxScore, grade: gradeFor(a.totalScore, grades).grade, pending: a.markingStatus === 'PENDING' };
        });
        const taken = scores.filter(c => c.status === 'Submitted');
        const total = round1(taken.reduce((n, c) => n + c.percentage, 0));
        const average = taken.length ? round1(total / taken.length) : null;
        return { studentProfileId: s.id, name: s.name, admissionNo: s.admissionNo, scores, taken: taken.length, total, average, grade: average === null ? '' : gradeFor(average, grades).grade };
    });
    rank(rows.filter(r => r.average !== null), r => r.average);
    rows.forEach(r => { if (r.average === null) r.position = null; });
    rows.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.no = i + 1; });

    const subjectStats = exams.map((e, i) => {
        const p = rows.map(r => r.scores[i]).filter(c => c.status === 'Submitted').map(c => c.percentage);
        return { average: p.length ? round1(p.reduce((a, b) => a + b, 0) / p.length) : null, highest: p.length ? Math.max(...p) : null, lowest: p.length ? Math.min(...p) : null };
    });
    return { rows, subjectStats };
};

// ─── rendering ───────────────────────────────────────────────────────────────
const cell = (v, d = '–') => (v === null || v === undefined || v === '' ? d : v);

const examTable = (sheet) => ({
    head: ['#', 'Name', 'Adm. No', 'Objective', 'Essay', 'Total', 'Max', '%', 'Grade', 'Position', 'Status'],
    rows: sheet.rows.map(r => [r.no, r.name, r.admissionNo, cell(r.objective), cell(r.essay), cell(r.total), cell(r.maxScore), cell(r.percentage), r.grade || '–', cell(r.position),
        r.pending ? 'Essays pending' : r.status]),
    numericFrom: 3,
});

const masterTable = (exams, sheet) => ({
    head: ['#', 'Name', 'Adm. No', ...exams.map(e => `${e.subjectName}${e.title ? `\n${e.title}` : ''}`), 'Exams', 'Average %', 'Grade', 'Position'],
    rows: sheet.rows.map(r => [r.no, r.name, r.admissionNo, ...r.scores.map(c => (c.status === 'Submitted' ? `${c.percentage}${c.pending ? '*' : ''}` : c.status === 'Exempted' ? 'EX' : c.status === 'Absent' ? 'ABS' : '…')),
        r.taken, cell(r.average), r.grade || '–', cell(r.position)]),
    numericFrom: 3,
});

const toXlsx = ({ school, title, subtitle, table, footer = [] }) => {
    const aoa = [[school?.schoolName || ''], [title], [subtitle], [], table.head, ...table.rows, [], ...footer.map(f => [f])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = table.head.map((_, i) => ({ wch: i === 1 ? 28 : i === 2 ? 14 : 12 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

const toPdf = async ({ school, cfg, title, subtitle, table, footer = [], landscape = false }) => {
    const th = table.head.map(h => `<th>${esc(h).replace(/\n/g, '<br/>')}</th>`).join('');
    const body = table.rows.map(r => `<tr>${r.map((c, i) => `<td${i >= table.numericFrom ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:${esc(cfg.fontFamily || 'Arial')},Helvetica,sans-serif;font-size:${Number(cfg.fontSizePt) || 10}pt;color:#111}
        h1{font-size:15pt;margin:2px 0} .sub{font-size:9.5pt;color:#444;margin:0 0 8px}
        table{border-collapse:collapse;width:100%} th,td{border:1px solid #666;padding:3px 5px} th{background:#e8edf7;font-size:8.5pt;text-align:center} td.n{text-align:center} tr{page-break-inside:avoid}
        tbody tr:nth-child(even){background:#f7f8fb} .foot{margin-top:10px;font-size:8.5pt;color:#444}
    </style></head><body>${await letterhead(school, cfg)}<h1>${esc(title)}</h1><p class="sub">${esc(subtitle)}</p>
    <table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>
    ${footer.length ? `<div class="foot">${footer.map(esc).join('<br/>')}</div>` : ''}
    ${cfg.footerText ? `<p class="foot" style="text-align:center">${esc(cfg.footerText)}</p>` : ''}</body></html>`;
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        return Buffer.from(await page.pdf({
            format: cfg.pageSize === 'Letter' ? 'Letter' : 'A4', landscape, printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
            displayHeaderFooter: true, headerTemplate: '<span></span>',
            footerTemplate: `<div style="width:100%;font-size:8px;color:#777;text-align:center">${esc(title.slice(0, 80))} · Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
        }));
    } finally { await page.close().catch(() => {}); }
};

module.exports = { loadGrades, gradeFor, buildExamSheet, buildMasterSheet, examTable, masterTable, toXlsx, toPdf };
