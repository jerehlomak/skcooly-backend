const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

const prisma = new PrismaClient();

async function main() {
    // 1. Find a user with role ADMIN (School Admin)
    let admin = await prisma.user.findFirst({
        where: { role: 'ADMIN' }
    });

    if (admin) {
        const password = await argon2.hash('Admin@1234');
        await prisma.user.update({
            where: { id: admin.id },
            data: { password }
        });
        console.log('--- SCHOOL ADMIN CREDENTIALS ---');
        console.log('Email:', admin.email);
        console.log('Password set to: Admin@1234');
        if (admin.schoolId) {
            console.log('School ID:', admin.schoolId);
        }
    } else {
        console.log('No admin found.');
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
