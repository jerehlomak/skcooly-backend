const XLSX = require('xlsx');
const prisma = require('../db/prisma');
const { getBrowser, letterhead, esc } = require('./academic-export.service');
const { schoolNow, toMin, isWorkday, isHoliday, weekdayOf } = require('./attendance-core.service');

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const eachDate = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const round1 = (n) => Math.round(n * 10) / 10;
const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

/** Turns day / week / month / term / session / year / custom into an inclusive date range. */
const resolvePeriod = async (schoolId, q, tz) => {
    const today = schoolNow(tz).dateStr;
    const period = q.period || 'month';
    const date = q.date || today;
    if (period === 'day') return { from: date, to: date, label: date, period };
    if (period === 'week') {
        const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
        const from = addDays(date, -dow);
        return { from, to: addDays(from, 6), label: `Week of ${from}`, period };
    }
    if (period === 'month') {
        const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : today.slice(0, 7);
        const [y, mo] = m.split('-').map(Number);
        return { from: `${m}-01`, to: `${m}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`, label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), period };
    }
    if (period === 'year') { const y = /^\d{4}$/.test(q.year || '') ? q.year : today.slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31`, label: y, period }; }
    if (period === 'term') {
        const t = await prisma.academicTerm.findFirst({ where: { id: q.termId, schoolId }, include: { session: { select: { name: true } } } });
        if (!t?.startDate || !t?.endDate) throw bad('That term has no start and end dates. Set them under Academic Sessions.');
        return { from: iso(t.startDate), to: iso(t.endDate), label: `${t.name} ${t.session?.name || ''}`.trim(), period };
    }
    if (period === 'session') {
        const s = await prisma.academicSession.findFirst({ where: { id: q.sessionId, schoolId }, include: { AcademicTerm: true } });
        if (!s) throw bad('Choose a session.');
        const dates = [s.startDate, s.endDate, ...s.AcademicTerm.flatMap(t => [t.startDate, t.endDate])].filter(Boolean).map(d => iso(d)).sort();
        if (!dates.length) throw bad('That session has no dates. Set them under Academic Sessions.');
        return { from: dates[0], to: dates[dates.length - 1], label: `${s.name} session`, period };
    }
    if (period === 'custom') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.to || '') || q.from > q.to) throw bad('Choose a valid start and end date.');
        if (eachDate(q.from, q.to).length > 800) throw bad('That range is too long.');
        return { from: q.from, to: q.to, label: `${q.from} to ${q.to}`, period };
    }
    throw bad('Unknown period.');
};

const LETTER = { PRESENT: 'P', LATE: 'L', ABSENT: 'A', EXCUSED: 'E', HALF_DAY: 'H' };

// ─── staff ───────────────────────────────────────────────────────────────────
/** Which days count as absences: up to yesterday, or today once the day has closed. */
const cutoffDate = (settings) => {
    const sn = schoolNow(settings.timezone);
    return sn.minutes >= toMin(settings.autoCloseTime || '17:00') ? sn.dateStr : addDays(sn.dateStr, -1);
};

const staffReport = async (schoolId, settings, { from, to, staffId }) => {
    const staff = await prisma.teacherProfile.findMany({
        where: { schoolId, isDeleted: false, status: { in: ['Active', 'ACTIVE', 'active'] }, ...(staffId && { id: staffId }) },
        include: { user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } },
    });
    const ids = staff.map(s => s.id);
    const [records, policies] = await Promise.all([
        prisma.staffAttendance.findMany({ where: { schoolId, staffId: { in: ids }, date: { gte: from, lte: to } } }),
        prisma.staffAttendancePolicy.findMany({ where: { staffId: { in: ids } } }),
    ]);
    const pol = new Map(policies.map(p => [p.staffId, p]));
    const byStaff = new Map();
    records.forEach(r => { if (!byStaff.has(r.staffId)) byStaff.set(r.staffId, new Map()); byStaff.get(r.staffId).set(r.date, r); });
    const cutoff = cutoffDate(settings);
    const dates = eachDate(from, to);
    const daily = Object.fromEntries(dates.map(d => [d, { present: 0, late: 0, absent: 0, excused: 0, halfDay: 0 }]));

    const rows = staff.map(s => {
        const p = pol.get(s.id); const recs = byStaff.get(s.id) || new Map();
        const hired = s.hireDate ? iso(s.hireDate) : from;
        const row = { staffId: s.id, name: s.user?.name || s.employeeId, employeeId: s.employeeId, department: s.department || '', expected: 0, workdays: 0, present: 0, late: 0, halfDay: 0, excused: 0, absent: 0, lateMinutes: 0, earlyLeaves: 0, workedMinutes: 0, noSignOut: 0, exempt: !!p?.exempt, days: {} };
        for (const d of dates) {
            if (d < hired) continue;
            const working = isWorkday(settings, p, d);
            if (working) row.workdays++;
            const r = recs.get(d);
            if (r) {
                const st = r.status;
                if (st === 'PRESENT') { row.present++; daily[d].present++; }
                else if (st === 'LATE') { row.late++; row.lateMinutes += r.lateMinutes || 0; daily[d].late++; }
                else if (st === 'HALF_DAY') { row.halfDay++; daily[d].halfDay++; }
                else if (st === 'EXCUSED') { row.excused++; daily[d].excused++; }
                else { row.absent++; daily[d].absent++; }
                if (r.earlyLeaveMinutes > 0) row.earlyLeaves++;
                if (r.checkInTime && r.checkOutTime) row.workedMinutes += Math.round((r.checkOutTime - r.checkInTime) / 60000);
                if (r.checkInTime && !r.checkOutTime && d < cutoff) row.noSignOut++;
                row.days[d] = LETTER[st] || 'A';
                if (working && d <= cutoff) row.expected++;
            } else if (working && d <= cutoff) {
                row.expected++; row.absent++; row.days[d] = 'A'; daily[d].absent++;
            }
        }
        const attended = row.present + row.late + row.halfDay * 0.5;
        const denom = row.expected - row.excused;
        row.attendanceRate = denom > 0 ? Math.min(100, round1((attended / denom) * 100)) : null;
        row.punctuality = row.present + row.late > 0 ? round1((row.present / (row.present + row.late)) * 100) : null;
        row.avgHours = row.present + row.late + row.halfDay > 0 ? round1(row.workedMinutes / 60 / Math.max(1, row.present + row.late + row.halfDay)) : 0;
        return row;
    });
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    const rates = rows.map(r => r.attendanceRate).filter(r => r !== null);
    return {
        kind: 'staff', from, to, rows, daily,
        totals: { staff: rows.length, present: sum('present'), late: sum('late'), halfDay: sum('halfDay'), excused: sum('excused'), absent: sum('absent'), lateMinutes: sum('lateMinutes'), earlyLeaves: sum('earlyLeaves'), averageRate: rates.length ? round1(rates.reduce((a, b) => a + b, 0) / rates.length) : null },
    };
};

// ─── students ────────────────────────────────────────────────────────────────
const studentReport = async (schoolId, { from, to, classId, studentId, classIds }) => {
    const students = await prisma.studentProfile.findMany({
        where: { schoolId, isDeleted: false, status: 'Active', ...(studentId && { id: studentId }), ...(classId && { classId }), ...(classIds && { classId: { in: classIds } }) },
        include: { user: { select: { name: true } }, classArm: { select: { name: true } } },
    });
    const recs = await prisma.attendanceRecord.findMany({ where: { schoolId, isDeleted: false, studentProfileId: { in: students.map(s => s.id) }, date: { gte: from, lte: to } } });
    const by = new Map();
    recs.forEach(r => { if (!by.has(r.studentProfileId)) by.set(r.studentProfileId, []); by.get(r.studentProfileId).push(r); });
    const dates = eachDate(from, to);
    const daily = Object.fromEntries(dates.map(d => [d, { present: 0, late: 0, absent: 0, excused: 0 }]));

    const rows = students.map(s => {
        const r = by.get(s.id) || [];
        const c = { present: 0, late: 0, absent: 0, excused: 0 };
        const days = {};
        r.forEach(x => { const k = x.status.toLowerCase(); c[k]++; days[x.date] = LETTER[x.status]; if (daily[x.date]) daily[x.date][k]++; });
        const marked = c.present + c.late + c.absent;
        return {
            studentId: s.id, name: s.user?.name || s.admissionNo, admissionNo: s.admissionNo, classId: s.classId, className: s.classArm?.name || '', ...c, daysMarked: r.length, days,
            attendanceRate: marked > 0 ? round1(((c.present + c.late) / marked) * 100) : null,
            punctuality: c.present + c.late > 0 ? round1((c.present / (c.present + c.late)) * 100) : null,
        };
    }).sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name));

    const classes = {};
    rows.forEach(r => { const c = classes[r.className || '—'] ||= { className: r.className || '—', students: 0, present: 0, late: 0, absent: 0, excused: 0 }; c.students++; ['present', 'late', 'absent', 'excused'].forEach(k => { c[k] += r[k]; }); });
    const classRows = Object.values(classes).map(c => ({ ...c, attendanceRate: c.present + c.late + c.absent > 0 ? round1(((c.present + c.late) / (c.present + c.late + c.absent)) * 100) : null })).sort((a, b) => a.className.localeCompare(b.className));
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    const tot = sum('present') + sum('late') + sum('absent');
    return { kind: 'students', from, to, rows, classRows, daily, totals: { students: rows.length, present: sum('present'), late: sum('late'), absent: sum('absent'), excused: sum('excused'), averageRate: tot > 0 ? round1(((sum('present') + sum('late')) / tot) * 100) : null } };
};

// ─── tables for export ──────────────────────────────────────────────────────
const fmtH = (m) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;

const buildTables = (rep) => {
    const dates = eachDate(rep.from, rep.to);
    const matrix = dates.length <= 31 && rep.rows.length > 0;
    const sheets = [];
    if (rep.kind === 'staff') {
        sheets.push({ name: 'Summary', head: ['#', 'Name', 'Employee ID', 'Dept', 'Expected days', 'Present', 'Late', 'Half day', 'Excused', 'Absent', 'Late minutes', 'Early leaves', 'Hours worked', 'Attendance %', 'Punctuality %'],
            rows: rep.rows.map((r, i) => [i + 1, r.name, r.employeeId, r.department, r.expected, r.present, r.late, r.halfDay, r.excused, r.absent, r.lateMinutes, r.earlyLeaves, fmtH(r.workedMinutes), r.attendanceRate ?? '–', r.punctuality ?? '–']) });
    } else {
        sheets.push({ name: 'Summary', head: ['#', 'Name', 'Adm. No', 'Class', 'Present', 'Late', 'Absent', 'Excused', 'Days marked', 'Attendance %', 'Punctuality %'],
            rows: rep.rows.map((r, i) => [i + 1, r.name, r.admissionNo, r.className, r.present, r.late, r.absent, r.excused, r.daysMarked, r.attendanceRate ?? '–', r.punctuality ?? '–']) });
        if (rep.classRows.length > 1) sheets.push({ name: 'By class', head: ['Class', 'Students', 'Present', 'Late', 'Absent', 'Excused', 'Attendance %'], rows: rep.classRows.map(c => [c.className, c.students, c.present, c.late, c.absent, c.excused, c.attendanceRate ?? '–']) });
    }
    if (matrix) sheets.push({ name: 'Register', head: ['#', 'Name', ...dates.map(d => d.slice(8)), 'P', 'L', 'A'], rows: rep.rows.map((r, i) => [i + 1, r.name, ...dates.map(d => r.days[d] || ''), r.present, r.late, r.absent]), dense: true });
    return sheets;
};

const titleOf = (rep, label, scopeLabel) => `${rep.kind === 'staff' ? 'Staff' : 'Student'} Attendance Report — ${scopeLabel}${label ? ` (${label})` : ''}`;

const toXlsx = ({ rep, label, scopeLabel, school }) => {
    const wb = XLSX.utils.book_new();
    buildTables(rep).forEach(t => {
        const top = t.name === 'Summary' ? [[school?.schoolName || ''], [titleOf(rep, label, scopeLabel)], [`${rep.from} to ${rep.to}`], []] : [];
        const ws = XLSX.utils.aoa_to_sheet([...top, t.head, ...t.rows]);
        ws['!cols'] = t.head.map((_, i) => ({ wch: t.dense ? (i === 1 ? 26 : 4) : i === 1 ? 26 : 13 }));
        XLSX.utils.book_append_sheet(wb, ws, t.name);
    });
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

const toPdf = async ({ rep, label, scopeLabel, school, cfg }) => {
    const tables = buildTables(rep);
    const t = rep.totals;
    const stats = rep.kind === 'staff'
        ? [['Staff', t.staff], ['Present', t.present], ['Late', t.late], ['Absent', t.absent], ['Avg attendance', t.averageRate == null ? '–' : `${t.averageRate}%`]]
        : [['Students', t.students], ['Present', t.present], ['Late', t.late], ['Absent', t.absent], ['Avg attendance', t.averageRate == null ? '–' : `${t.averageRate}%`]];
    const tbl = (x) => `<h3>${esc(x.name)}</h3><table class="${x.dense ? 'dense' : ''}"><thead><tr>${x.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${x.rows.map(r => `<tr>${r.map((c, i) => `<td${i > 1 || x.dense ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;color:#111} h1{font-size:15pt;margin:2px 0} h3{font-size:11pt;margin:14px 0 4px} .sub{color:#555;font-size:9pt;margin:0 0 8px}
        .stats{display:flex;gap:10px;margin:8px 0}.stat{border:1px solid #bbb;border-radius:6px;padding:5px 12px}.stat b{display:block;font-size:13pt}
        table{border-collapse:collapse;width:100%} th,td{border:1px solid #777;padding:3px 5px} th{background:#e8edf7;font-size:8pt} td.n{text-align:center} tr{page-break-inside:avoid} tbody tr:nth-child(even){background:#f7f8fb}
        table.dense th,table.dense td{padding:2px;font-size:7.5pt} .foot{font-size:8pt;color:#555;margin-top:8px}
    </style></head><body>${await letterhead(school, cfg)}<h1>${esc(titleOf(rep, '', scopeLabel))}</h1><p class="sub">${esc(label)} · ${rep.from} to ${rep.to}</p>
    <div class="stats">${stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    ${tables.map(tbl).join('')}<p class="foot">P = present · L = late · A = absent · E = excused · H = half day. Generated ${new Date().toLocaleString('en-GB')}.</p></body></html>`;
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        return Buffer.from(await page.pdf({
            format: 'A4', landscape: tables.some(x => x.head.length > 11), printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
            displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="width:100%;font-size:8px;color:#777;text-align:center">Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        }));
    } finally { await page.close().catch(() => {}); }
};

module.exports = { resolvePeriod, staffReport, studentReport, eachDate, addDays, toXlsx, toPdf, cutoffDate, isHoliday, weekdayOf, iso };
