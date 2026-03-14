const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function debug() {
    try {
        const school = await prisma.school.findFirst();
        if (!school) {
            console.log('No school found');
            return;
        }
        const schoolId = school.id;
        console.log('Using schoolId:', schoolId);

        const student = await prisma.studentProfile.findFirst({
            where: { schoolId, isDeleted: false },
            include: { user: true }
        });
        if (!student) {
            console.log('No student found');
            return;
        }
        console.log('Using student:', student.user.name, 'ID:', student.id);

        const fee = await prisma.feeParticular.findFirst({
            where: { schoolId, isDeleted: false }
        });
        if (!fee) {
            console.log('No fee found');
            return;
        }
        console.log('Using fee:', fee.label, 'ID:', fee.id);

        const term = 'First Term';
        const year = '2025/2026';

        console.log('Attempting assignment...');

        await prisma.$transaction(async (tx) => {
            let invoice = await tx.feeInvoice.findFirst({
                where: { studentProfileId: student.id, term, year, isDeleted: false },
                include: { items: true }
            });

            if (!invoice) {
                console.log('Creating new invoice...');
                invoice = await tx.feeInvoice.create({
                    data: {
                        schoolId,
                        studentProfileId: student.id,
                        term,
                        year,
                        totalAmount: fee.amount,
                        amountPaid: 0,
                        status: 'Unpaid'
                    },
                    include: { items: true }
                });
            } else {
                console.log('Updating existing invoice...');
                invoice = await tx.feeInvoice.update({
                    where: { id: invoice.id },
                    data: {
                        totalAmount: invoice.totalAmount + fee.amount
                    },
                    include: { items: true }
                });
            }

            const lastLedger = await tx.studentLedger.findFirst({
                where: { studentProfileId: student.id },
                orderBy: { createdAt: 'desc' }
            });
            let currentBalance = lastLedger ? lastLedger.balanceAfter : 0;
            console.log('Current balance:', currentBalance);

            const existingItem = (invoice.items || []).find(i => i.feeParticularId === fee.id);
            if (!existingItem) {
                console.log('Adding invoice item...');
                await tx.feeInvoiceItem.create({
                    data: {
                        feeInvoiceId: invoice.id,
                        feeParticularId: fee.id,
                        label: fee.label,
                        amount: fee.amount
                    }
                });

                currentBalance += fee.amount;
                console.log('Creating ledger entry. New balance:', currentBalance);

                await tx.studentLedger.create({
                    data: {
                        schoolId,
                        studentProfileId: student.id,
                        type: 'DEBIT',
                        category: 'Fee Assignment',
                        description: `Assigned: ${fee.label} (${term} ${year})`,
                        amount: fee.amount,
                        balanceAfter: currentBalance,
                        feeInvoiceId: invoice.id
                    }
                });
                console.log('STUCCESS!');
            } else {
                console.log('Item already exists on this invoice.');
            }
        });

    } catch (err) {
        console.error('DEBUG ERROR:', err);
    } finally {
        await prisma.$disconnect();
    }
}

debug();
