const XLSX = require('xlsx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { buildLayout, DEFAULT_CONFIG } = require('./timetable-engine.service');

const KIND_LABEL = { CLASS: 'Class Timetable', EXAM: 'Exam Timetable', ACTIVITY: 'Activity Timetable' };
const dateStr = (d) => new Date(d).toISOString().slice(0, 10);
const pretty = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const latin = (s) => String(s ?? '').replace(/[^\x20-\xFF]/g, '?'); // StandardFonts only encode WinAnsi

const layoutFor = (timetable, classId) => timetable.layouts?.[classId] || buildLayout(DEFAULT_CONFIG);

/** Rows for a weekly grid: [{ label, time, cells: { [day]: string } , isBreak }] */
const weeklyRows = (layout, slots) => {
    const rows = [];
    layout.periods.forEach(p => {
        if (p.type === 'BREAK') { rows.push({ label: p.label, time: `${p.start}–${p.end}`, isBreak: true, cells: {} }); return; }
        const cells = {};
        layout.days.forEach(d => {
            const s = slots.find(x => x.day === d && x.period === p.index);
            if (s) cells[d] = [s.title, s.teacherName, s.room].filter(Boolean).join(' · ');
        });
        rows.push({ index: p.index, label: p.label, time: `${p.start}–${p.end}`, isBreak: false, cells });
    });
    return rows;
};

const datedRows = (slots, classes) => {
    const cn = Object.fromEntries(classes.map(c => [c.id, c.name]));
    return [...slots]
        .sort((a, b) => dateStr(a.date).localeCompare(dateStr(b.date)) || a.startTime.localeCompare(b.startTime) || (cn[a.classId] || '').localeCompare(cn[b.classId] || ''))
        .map(s => ({ date: dateStr(s.date), pretty: pretty(s.date), time: `${s.startTime}–${s.endTime}`, className: cn[s.classId] || '', title: s.title, who: s.teacherName || '', room: s.room || '' }));
};

// ─── Excel ───────────────────────────────────────────────────────────────────
const buildXlsx = ({ timetable, slots, classes, schoolName, scopeName }) => {
    const wb = XLSX.utils.book_new();
    const used = new Set();
    const sheetName = (n) => { let base = n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet'; let name = base, i = 2; while (used.has(name)) name = `${base.slice(0, 25)} ${i++}`; used.add(name); return name; };

    if (timetable.kind === 'CLASS') {
        classes.forEach(cls => {
            const layout = layoutFor(timetable, cls.id);
            const mine = slots.filter(s => s.classId === cls.id);
            const aoa = [
                [schoolName], [`${KIND_LABEL[timetable.kind]}: ${timetable.name}`], [`${cls.name}${timetable.term ? ` · ${timetable.term}` : ''}${timetable.sessionName ? ` · ${timetable.sessionName}` : ''}`], [],
                ['Period', 'Time', ...layout.days],
                ...weeklyRows(layout, mine).map(r => [r.label, r.time, ...layout.days.map(d => (r.isBreak ? r.label.toUpperCase() : r.cells[d] || ''))]),
            ];
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            ws['!cols'] = [{ wch: 12 }, { wch: 14 }, ...layout.days.map(() => ({ wch: 26 }))];
            XLSX.utils.book_append_sheet(wb, ws, sheetName(cls.name));
        });
    } else {
        const rows = datedRows(slots, classes);
        const aoa = [
            [schoolName], [`${KIND_LABEL[timetable.kind]}${timetable.examType ? ` (${timetable.examType.replace(/_/g, ' ')})` : ''}: ${timetable.name}`], [scopeName], [],
            ['Date', 'Time', 'Class', timetable.kind === 'EXAM' ? 'Paper / Subject' : 'Activity', 'Invigilator / In charge', 'Venue'],
            ...rows.map(r => [r.date, r.time, r.className, r.title, r.who, r.room]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 28 }, { wch: 24 }, { wch: 16 }];
        XLSX.utils.book_append_sheet(wb, ws, sheetName(scopeName));
    }
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
};

// ─── PDF ─────────────────────────────────────────────────────────────────────
const fit = (font, text, size, maxW) => {
    let t = latin(text);
    if (font.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
    return t + '...';
};

const buildPdf = async ({ timetable, slots, classes, schoolName, scopeName }) => {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);
    const W = 841.89, H = 595.28, M = 32; // A4 landscape
    const ink = rgb(0.1, 0.13, 0.2), muted = rgb(0.4, 0.45, 0.55), line = rgb(0.82, 0.85, 0.9), head = rgb(0.0, 0.21, 0.63), breakBg = rgb(0.96, 0.96, 0.98);

    const header = (page, subtitle) => {
        page.drawText(fit(bold, schoolName, 16, W - 2 * M), { x: M, y: H - M - 12, size: 16, font: bold, color: head });
        page.drawText(fit(reg, `${KIND_LABEL[timetable.kind]}: ${timetable.name}`, 10, W - 2 * M), { x: M, y: H - M - 28, size: 10, font: reg, color: ink });
        page.drawText(fit(bold, subtitle, 12, W - 2 * M), { x: M, y: H - M - 46, size: 12, font: bold, color: ink });
        return H - M - 62;
    };

    if (timetable.kind === 'CLASS') {
        classes.forEach(cls => {
            const layout = layoutFor(timetable, cls.id);
            const mine = slots.filter(s => s.classId === cls.id);
            const rows = weeklyRows(layout, mine);
            const page = pdf.addPage([W, H]);
            let y = header(page, `${cls.name}${timetable.term ? ` · ${timetable.term}` : ''}${timetable.sessionName ? ` · ${timetable.sessionName}` : ''}`);

            const firstW = 86, colW = (W - 2 * M - firstW) / layout.days.length;
            const rowH = Math.min(52, (y - M - 24) / (rows.length + 1));
            page.drawRectangle({ x: M, y: y - 22, width: W - 2 * M, height: 22, color: head });
            page.drawText('Period', { x: M + 6, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
            layout.days.forEach((d, i) => page.drawText(latin(d), { x: M + firstW + i * colW + 6, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) }));
            y -= 22;

            rows.forEach(r => {
                const h = r.isBreak ? Math.min(20, rowH) : rowH;
                page.drawRectangle({ x: M, y: y - h, width: W - 2 * M, height: h, borderColor: line, borderWidth: 0.5, color: r.isBreak ? breakBg : undefined });
                page.drawText(fit(bold, r.label, 8.5, firstW - 8), { x: M + 6, y: y - 12, size: 8.5, font: bold, color: ink });
                page.drawText(r.time, { x: M + 6, y: y - 23, size: 7, font: reg, color: muted });
                if (r.isBreak) {
                    page.drawText(latin(r.label.toUpperCase()), { x: M + firstW + 6, y: y - h / 2 - 3, size: 8, font: bold, color: muted });
                } else {
                    layout.days.forEach((d, i) => {
                        const s = mine.find(x => x.day === d && x.period === r.index);
                        if (!s) return;
                        const x = M + firstW + i * colW + 5;
                        page.drawText(fit(bold, s.title, 8.5, colW - 10), { x, y: y - 13, size: 8.5, font: bold, color: ink });
                        if (s.teacherName) page.drawText(fit(reg, s.teacherName, 7.5, colW - 10), { x, y: y - 24, size: 7.5, font: reg, color: muted });
                        if (s.room) page.drawText(fit(reg, s.room, 7, colW - 10), { x, y: y - 34, size: 7, font: reg, color: muted });
                    });
                }
                y -= h;
            });
            for (let i = 0; i <= layout.days.length; i++) page.drawLine({ start: { x: M + (i === 0 ? 0 : firstW + (i - 1) * colW), y: y }, end: { x: M + (i === 0 ? 0 : firstW + (i - 1) * colW), y: y + rows.reduce((a, r) => a + (r.isBreak ? Math.min(20, rowH) : rowH), 0) }, thickness: 0.5, color: line });
        });
    } else {
        const rows = datedRows(slots, classes);
        const cols = [['Date', 110], ['Time', 80], ['Class', 110], [timetable.kind === 'EXAM' ? 'Paper / Subject' : 'Activity', 190], ['Invigilator / In charge', 140], ['Venue', 90]];
        let page = null, y = 0;
        const newPage = () => {
            page = pdf.addPage([W, H]);
            y = header(page, `${scopeName}${timetable.examType ? ` · ${timetable.examType.replace(/_/g, ' ')}` : ''}`);
            page.drawRectangle({ x: M, y: y - 20, width: W - 2 * M, height: 20, color: head });
            let x = M; cols.forEach(([n, w]) => { page.drawText(n, { x: x + 6, y: y - 14, size: 9, font: bold, color: rgb(1, 1, 1) }); x += w; });
            y -= 20;
        };
        newPage();
        rows.forEach((r, idx) => {
            if (y - 20 < M) newPage();
            if (idx % 2) page.drawRectangle({ x: M, y: y - 20, width: W - 2 * M, height: 20, color: breakBg });
            let x = M;
            [r.pretty, r.time, r.className, r.title, r.who, r.room].forEach((v, i) => { page.drawText(fit(reg, v, 8.5, cols[i][1] - 10), { x: x + 6, y: y - 13, size: 8.5, font: reg, color: ink }); x += cols[i][1]; });
            y -= 20;
        });
        if (!rows.length) page.drawText('No entries yet.', { x: M, y: y - 20, size: 10, font: reg, color: muted });
    }
    return { buffer: Buffer.from(await pdf.save()), contentType: 'application/pdf', extension: 'pdf' };
};

const buildExport = async (opts) => (opts.format === 'pdf' ? buildPdf(opts) : buildXlsx(opts));

module.exports = { buildExport };
