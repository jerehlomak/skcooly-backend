const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const students = await prisma.studentProfile.findMany({ select: { id: true, user: { select: { name: true } } } });
    console.log('Students:', JSON.stringify(students, null, 2));

    const results = await prisma.studentResult.findMany({
        orderBy: { createdAt: 'desc' }
    });
    console.log('Results:', JSON.stringify(results, null, 2));
}

main().finally(() => prisma.$disconnect());
