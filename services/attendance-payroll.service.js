const prisma = require('../db/prisma');
const { getSettings, mergeDeduction, isWorkday } = require('./attendance-core.service');
const { staffReport, eachDate } = require('./attendance-report.service');

const money = (n) => Math.round(n * 100) / 100;

/**
 * Salary deductions for lateness and absence over a period, following each staff member's own arrangement
 * (or the school default). `grossByStaff` = { staffId: monthly gross }. Returns { staffId: { lates, absences, amount, lines } }.
 */
const computeStaffDeductions = async ({ schoolId, from, to, grossByStaff }) => {
    const settings = await getSettings(schoolId);
    const rep = await staffReport(schoolId, settings, { from, to });
    const policies = await prisma.staffAttendancePolicy.findMany({ where: { schoolId } });
    const pol = new Map(policies.map(p => [p.staffId, p]));
    const out = {};
    for (const r of rep.rows) {
        const p = pol.get(r.staffId);
        const d = p?.useSchoolDeduction === false ? mergeDeduction(p.deduction) : settings.deduction;
        const gross = grossByStaff?.[r.staffId] ?? 0;
        const days = eachDate(from, to).filter(x => isWorkday(settings, p, x)).length || 1; // working days in the whole period
        const daily = gross / days;
        const absentDays = r.absent + (d.halfDayAsHalfAbsent ? r.halfDay * 0.5 : 0);
        const lines = [];
        if (!r.exempt && !p?.exempt) {
            const billable = Math.max(0, r.late - (d.lateFreePerMonth || 0));
            if (d.lateMode === 'PER_LATE' && billable > 0 && d.lateAmount > 0) lines.push({ name: `Lateness (${r.late} late${r.late === 1 ? '' : 's'}, ${d.lateFreePerMonth || 0} free)`, amount: money(billable * d.lateAmount) });
            if (d.lateMode === 'PER_MINUTE' && r.lateMinutes > 0 && d.lateAmount > 0) lines.push({ name: `Lateness (${r.lateMinutes} min)`, amount: money(r.lateMinutes * d.lateAmount) });
            if (d.lateMode === 'PERCENT_OF_DAILY' && billable > 0 && d.lateAmount > 0) lines.push({ name: `Lateness (${r.late} late${r.late === 1 ? '' : 's'})`, amount: money(billable * daily * (d.lateAmount / 100)) });
            if (d.absentMode === 'DAILY_RATE' && absentDays > 0) lines.push({ name: `Absence (${absentDays} day${absentDays === 1 ? '' : 's'})`, amount: money(absentDays * daily) });
            if (d.absentMode === 'FIXED_PER_DAY' && absentDays > 0 && d.absentAmount > 0) lines.push({ name: `Absence (${absentDays} day${absentDays === 1 ? '' : 's'})`, amount: money(absentDays * d.absentAmount) });
        }
        let total = lines.reduce((n, l) => n + l.amount, 0);
        const cap = gross > 0 ? gross * ((d.maxPercentOfGross ?? 100) / 100) : total;
        if (total > cap) { // keep the deduction within the school's cap by scaling the lines down
            const k = cap / total; lines.forEach(l => { l.amount = money(l.amount * k); }); total = lines.reduce((n, l) => n + l.amount, 0);
        }
        out[r.staffId] = { lates: r.late, lateMinutes: r.lateMinutes, absences: absentDays, halfDays: r.halfDay, amount: money(total), lines, exempt: !!(r.exempt || p?.exempt), expected: r.expected };
    }
    return out;
};

module.exports = { computeStaffDeductions };
