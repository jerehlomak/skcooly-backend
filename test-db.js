const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function test() {
    try {
        await prisma.$connect();
        console.log('Successfully connected to the database.');
        const count = await prisma.schoolSettings.count();
        console.log('SchoolSettings count:', count);
    } catch (err) {
        console.error('Database connection error:', err);
    } finally {
        await prisma.$disconnect();
    }
}
test();
