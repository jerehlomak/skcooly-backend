/**
 * Debug script - run manually: node debug-students.js
 * Tests the getClassStudents Prisma query directly
 */
const prisma = require('./db/prisma');

async function test() {
    const classId = '265e21d4-026f-4818-a120-405b8e620829';
    const schoolId = '28018997-f868-4717-8eef-994166f226f3'; // from your JWT

    console.log('Testing step 1: plain student query...');
    try {
        const students = await prisma.studentProfile.findMany({
            where: { classId, isDeleted: false },
            select: { id: true, admissionNo: true, classLevel: true, schoolId: true },
            take: 3
        });
        console.log('Step 1 OK - students:', JSON.stringify(students, null, 2));
    } catch (e) {
        console.error('Step 1 FAILED:', e.message);
        return;
    }

    console.log('\nTesting step 2: with FinanceInvoice include...');
    try {
        const students = await prisma.studentProfile.findMany({
            where: { classId, isDeleted: false },
            include: {
                user: { select: { name: true } },
                FinanceInvoice: {
                    where: { schoolId, isDeleted: false },
                    select: { id: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true, invoiceNumber: true }
                },
            },
            take: 2
        });
        console.log('Step 2 OK - count:', students.length);
    } catch (e) {
        console.error('Step 2 FAILED:', e.message);
        return;
    }

    console.log('\nTesting step 3: with Scholarship include...');
    try {
        const students = await prisma.studentProfile.findMany({
            where: { classId, isDeleted: false },
            include: {
                user: { select: { name: true } },
                Scholarship: {
                    where: { isDeleted: false },
                    select: { id: true, type: true, value: true, status: true }
                }
            },
            take: 2
        });
        console.log('Step 3 OK - count:', students.length);
    } catch (e) {
        console.error('Step 3 FAILED:', e.message);
    }
}

test().finally(() => prisma.$disconnect());
