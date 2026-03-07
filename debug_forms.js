const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const fs = require('fs');

async function main() {
    let out = '';
    const classes = await p.class.findMany({ select: { id: true, name: true, formTeacherId: true } });
    out += '=== CLASSES ===\n';
    classes.forEach(c => out += `${c.name}: formTeacherId=${c.formTeacherId}\n`);

    const teachers = await p.teacherProfile.findMany({ select: { id: true, userId: true, employeeId: true } });
    out += '\n=== TEACHER PROFILES ===\n';
    teachers.forEach(t => out += `employeeId=${t.employeeId}, profile.id=${t.id}, userId=${t.userId}\n`);

    fs.writeFileSync('debug_forms.txt', out, 'utf-8');
}

main().finally(() => p.$disconnect());
