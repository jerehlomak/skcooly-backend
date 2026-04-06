const prisma = require('./db/prisma');

async function test() {
    try {
        const admin = await prisma.centralAdmin.findFirst();
        const school = await prisma.school.findFirst();
        
        if (!school || !admin) {
            console.log("No school or admin found");
            return;
        }

        const count = await prisma.invoice.count();
        const invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
        const items = [{ itemName: 'Test Item', quantity: 1, unitPrice: 1000, total: 1000 }];

        const subtotal = 1000;
        const totalAmount = 1000;

        const invoice = await prisma.invoice.create({
            data: {
                schoolId: school.id, 
                invoiceNumber,
                title: 'Test Invoice',
                description: 'test',
                currency: 'NGN',
                taxAmount: 0,
                discountAmount: 0,
                amount: subtotal, 
                totalAmount,
                amountDue: totalAmount,
                dueDate: new Date(),
                status: 'DRAFT',
                createdByAdminId: admin.id,
                items: {
                    create: items.map(i => ({
                        itemName: i.itemName,
                        quantity: i.quantity,
                        unitPrice: i.unitPrice,
                        total: i.total,
                    }))
                }
            }
        });

        console.log("Success:", invoice.id);
    } catch (err) {
        console.error("Prisma error:", err);
    } finally {
        await prisma.$disconnect();
    }
}

test();
