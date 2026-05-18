const prisma = require('./db/prisma');

async function test() {
    const studentId = '29ce32e6-6667-4127-8fc2-8ff4caaa09fe';
    const schoolId  = '28018997-f868-4717-8eef-994166f226f3';

    console.log('── Scholarships for student ──');
    const scs = await prisma.scholarship.findMany({
        where: { schoolId, studentId, isDeleted: false }
    });
    console.log('All (any status):', JSON.stringify(scs, null, 2));

    const active = await prisma.scholarship.findMany({
        where: { schoolId, studentId, isDeleted: false, status: 'ACTIVE' }
    });
    console.log('\nACTIVE only:', JSON.stringify(active, null, 2));

    // Compute discount
    const subTotal = 71000; // PTA + School Fees
    let discountTotal = 0;
    for (const sc of active) {
        if (sc.type === 'PERCENTAGE') discountTotal += subTotal * (sc.value / 100);
        else if (sc.type === 'SCHOLARSHIP' || sc.type === 'FIXED_AMOUNT') discountTotal = Math.max(discountTotal, subTotal - sc.value);
    }
    discountTotal = Math.min(discountTotal, subTotal);
    console.log(`\nsubTotal=₦${subTotal} discountTotal=₦${discountTotal} totalAmount=₦${subTotal - discountTotal}`);
}

test().catch(console.error).finally(() => prisma.$disconnect());
