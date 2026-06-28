const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { generateUniquePins } = require('../utils/pinCodeGenerator');

(async () => {
    try {
        const school = await prisma.school.findFirst();
        if (!school) return console.log('No school found');
        const count = await prisma.schoolPinBatch.count();
        const batchNumber = `TEST-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

        const newBatch = await prisma.schoolPinBatch.create({
            data: {
                batchNumber, pinType: 'RESULT_CHECKING', quantity: 10, pricePerPin: 0, schoolId: school.id,
                adminId: (await prisma.centralAdmin.findFirst() || {id: 'test'}).id
            }
        });

        const pinCodes = await generateUniquePins(prisma, 10, 10);
        await prisma.schoolPin.createMany({
            data: pinCodes.map((pinCode, i) => ({
                batchId: newBatch.id, pinCode, serialNumber: `${batchNumber}-${String(i + 1).padStart(5, '0')}`,
                pinType: 'RESULT_CHECKING', schoolId: school.id, maxUsage: 5
            }))
        });

        console.log('--- TEST PINS GENERATED ---');
        console.log(pinCodes);
    } catch(e) { console.error(e) } finally { await prisma.$disconnect() }
})();
