const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { email: true, name: true, role: true }});
    const parent = await prisma.parentProfile.findFirst({ include: { user: { select: { email: true, name: true } } }});
    
    console.log('ADMIN:', admin);
    console.log('PARENT:', parent?.user);
}

main().catch(console.error).finally(() => prisma.$disconnect());
