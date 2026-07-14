// Seeds the Permission catalog (STAFF dashboard) from data/menuCatalog.js.
// Idempotent — safe to re-run after adding new menu items.
// Usage: node scripts/seed-permissions.js  (or `npm run seed:permissions`)

require('dotenv').config();
const prisma = require('../db/prisma');
const menuCatalog = require('../data/menuCatalog');

function deriveKey(path) {
    if (path === '/dashboard') return 'dashboard';
    const stripped = path.startsWith('/dashboard/')
        ? path.slice('/dashboard/'.length)
        : path.replace(/^\//, '');
    return stripped.replace(/\//g, '.');
}

function collectPermissions(nodes, topLevelTitle, sortOrder) {
    const rows = [];
    for (const node of nodes) {
        const module = topLevelTitle || node.title;
        if (node.path) {
            rows.push({
                key: deriveKey(node.path),
                label: node.title,
                module,
                path: node.path,
                sortOrder: sortOrder.value++,
            });
        }
        if (node.children) {
            rows.push(...collectPermissions(node.children, topLevelTitle || node.title, sortOrder));
        }
    }
    return rows;
}

async function seedPermissions() {
    const sortOrder = { value: 0 };
    const rows = collectPermissions(menuCatalog, null, sortOrder);

    // De-duplicate by key (a few routes are linked from more than one menu entry,
    // e.g. "ID Card" and "Admission > ID Card Layout" share a path) — keep the first.
    const seen = new Map();
    for (const row of rows) {
        if (!seen.has(row.key)) seen.set(row.key, row);
    }

    const existingKeys = new Set(
        (await prisma.permission.findMany({ where: { key: { in: [...seen.keys()] } }, select: { key: true } }))
            .map((p) => p.key)
    );

    for (const row of seen.values()) {
        await prisma.permission.upsert({
            where: { key: row.key },
            update: { label: row.label, module: row.module, path: row.path, sortOrder: row.sortOrder },
            create: {
                key: row.key,
                label: row.label,
                module: row.module,
                path: row.path,
                sortOrder: row.sortOrder,
                dashboardType: 'STAFF',
            },
        });
    }

    const created = [...seen.keys()].filter((k) => !existingKeys.has(k)).length;
    const updated = seen.size - created;
    console.log(`Permission catalog seeded: ${seen.size} unique keys (${created} created, ${updated} updated).`);
}

if (require.main === module) {
    seedPermissions()
        .catch((e) => { console.error(e); process.exit(1); })
        .finally(() => prisma.$disconnect());
}

module.exports = seedPermissions;
