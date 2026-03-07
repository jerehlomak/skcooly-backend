const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const fs = require('fs');

async function main() {
    const users = await p.user.findMany({ select: { id: true, name: true, role: true, email: true } });
    fs.writeFileSync('debug_users.txt', JSON.stringify(users, null, 2), 'utf-8');
}

main().finally(() => p.$disconnect());
