const prisma = require('../db/prisma');

async function main() {
    console.log('Seeding default school and assigning existing data...');

    // 1. Create or ensure a default subscription plan exists
    let plan = await prisma.subscriptionPlan.findFirst({
        where: { name: 'Pro' }
    });

    if (!plan) {
        plan = await prisma.subscriptionPlan.create({
            data: {
                name: 'Pro',
                description: 'Professional Plan',
                monthlyPrice: 79.99,
                yearlyPrice: 799.99,
                maxStudents: 500,
                maxTeachers: 50,
                maxClasses: 30,
                features: ['attendance', 'finance', 'messaging', 'reports'],
            }
        });
        console.log('Created default Pro plan.');
    }

    // 2. Create the default school
    const defaultEmail = 'admin@skooly.com'; // Using the central admin email domain or a generic one
    let school = await prisma.school.findFirst({
        where: { name: 'Skooly Default Academy' }
    });

    if (!school) {
        school = await prisma.school.create({
            data: {
                name: 'Skooly Default Academy',
                email: 'hello@skooly.com',
                phone: '+1234567890',
                address: '123 Education Lane',
                country: 'Nigeria',
                status: 'ACTIVE',
                planId: plan.id,
                adminEmail: 'default_admin@skooly.com', // Will be generated
            }
        });
        console.log(`Created default school: ${school.name} (ID: ${school.id})`);
    } else {
        console.log(`Default school already exists (ID: ${school.id})`);
    }

    const schoolId = school.id;

    // 3. Update all existing records that lack a schoolId
    const modelsToUpdate = [
        'user',
        'studentProfile',
        'teacherProfile',
        'parentProfile',
        'class',
        'subject',
        'course',
        'attendanceRecord',
        'timetableEntry',
        'message',
        'smsLog',
        'assessmentStructure',
        'studentResult',
        'feeInvoice',
        'salarySlip',
        'bankAccount',
        'feeParticular',
        'transaction',
        'schoolSettings'
    ];

    for (const modelName of modelsToUpdate) {
        try {
            if (prisma[modelName]) {
                const result = await prisma[modelName].updateMany({
                    where: { schoolId: null },
                    data: { schoolId }
                });
                if (result.count > 0) {
                    console.log(`Assigned ${result.count} existing ${modelName} records to the default school.`);
                }
            }
        } catch (err) {
            console.error(`Error updating ${modelName}:`, err.message);
        }
    }

    // 4. Update the school counts
    const studentCount = await prisma.studentProfile.count({ where: { schoolId, status: 'Active' } });
    const teacherCount = await prisma.teacherProfile.count({ where: { schoolId, status: 'Active' } });

    await prisma.school.update({
        where: { id: schoolId },
        data: { studentCount, teacherCount }
    });

    console.log(`Migration complete. Default school now has ${studentCount} students and ${teacherCount} teachers.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
