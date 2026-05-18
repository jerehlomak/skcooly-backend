const prisma = require('../db/prisma')

async function main() {
    console.log('Checking subscription plans in database...')
    const count = await prisma.subscriptionPlan.count()
    console.log(`Current plan count: ${count}`)

    if (count === 0) {
        console.log('Seeding default subscription plans...')
        await prisma.subscriptionPlan.createMany({
            data: [
                {
                    name: 'Basic',
                    description: 'Perfect for small schools getting started',
                    monthlyPrice: 15000,
                    yearlyPrice: 150000,
                    maxStudents: 300,
                    maxTeachers: 20,
                    maxClasses: 15,
                    features: ['students', 'teachers', 'classes', 'attendance', 'results'],
                    trialDays: 14,
                    isActive: true,
                },
                {
                    name: 'Pro',
                    description: 'For growing schools with advanced needs',
                    monthlyPrice: 35000,
                    yearlyPrice: 350000,
                    maxStudents: 1000,
                    maxTeachers: 60,
                    maxClasses: 40,
                    features: ['students', 'teachers', 'classes', 'attendance', 'results', 'timetable', 'finance', 'messaging'],
                    trialDays: 7,
                    isActive: true,
                },
                {
                    name: 'Enterprise',
                    description: 'Unlimited power for large institutions',
                    monthlyPrice: 85000,
                    yearlyPrice: 850000,
                    maxStudents: 10000,
                    maxTeachers: 500,
                    maxClasses: 200,
                    features: ['students', 'teachers', 'classes', 'attendance', 'results', 'timetable', 'finance', 'messaging', 'sms', 'analytics'],
                    trialDays: 0,
                    isActive: true,
                },
            ],
        })
        console.log('✅ Default subscription plans seeded successfully!')
    } else {
        console.log('ℹ️ Plans already exist. Setting isActive = true for all plans.')
        await prisma.subscriptionPlan.updateMany({
            data: { isActive: true }
        })
        console.log('✅ All existing plans set to active.')
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
