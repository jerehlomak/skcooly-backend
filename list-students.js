const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const students = await prisma.studentProfile.findMany({
            take: 10,
            include: { user: { select: { name: true } } }
        });
        console.log(JSON.stringify(students, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
