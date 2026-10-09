// One-off: gives schools that already exist the SchoolFeature (subscription) rows for
// permissions added to the catalog later, so they show up on the Roles & Restrictions
// screen. Each new permission copies the setting the school already has for a sibling
// item. It NEVER touches RolePermission, so no existing role gains anything — an admin
// must still tick the new items. Existing SchoolFeature rows are left as they are.
//
// Usage (run `node scripts/sync-permissions.js` first so the Permission rows exist):
//   node scripts/backfill-new-permissions.js --dry-run   # report only
//   node scripts/backfill-new-permissions.js             # apply

require('dotenv').config();
const prisma = require('../db/prisma');

// new permission key -> existing key whose subscription it should follow
const FOLLOWS = {
    'my-payroll': 'finance.dashboard',
    'finance.payment-management': 'finance.single-billing',
    'finance.all-payments': 'finance.fees',
    'finance.messages': 'finance.fees',
    'finance.assets': 'finance.inventory',
    'bulk-import.students': 'students.all',
    'bulk-import.parents': 'parents.all',
    'bulk-import.staff': 'employees.all',
};

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const keys = [...Object.keys(FOLLOWS), ...Object.values(FOLLOWS)];
    const perms = await prisma.permission.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(perms.map((p) => [p.key, p]));

    const schools = await prisma.school.findMany({ select: { id: true } });
    let toCreate = 0;
    for (const school of schools) {
        const rows = await prisma.schoolFeature.findMany({ where: { schoolId: school.id } });
        const enabledById = new Map(rows.map((r) => [r.permissionId, r.enabled]));
        const data = [];
        for (const [newKey, refKey] of Object.entries(FOLLOWS)) {
            const target = byKey.get(newKey);
            const ref = byKey.get(refKey);
            if (!target || !ref || enabledById.has(target.id)) continue;
            data.push({ schoolId: school.id, permissionId: target.id, enabled: enabledById.get(ref.id) === true });
        }
        toCreate += data.length;
        if (!dryRun && data.length) await prisma.schoolFeature.createMany({ data, skipDuplicates: true });
    }
    console.log(`${dryRun ? '[dry run] would create' : 'Created'} ${toCreate} SchoolFeature rows across ${schools.length} schools.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
