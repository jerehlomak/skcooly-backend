const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Starting migration to fix null Subject streams...');
    
    // We use executeRaw because Prisma Client won't even let us query rows that have null enum values 
    // without throwing the exact serialization error we are trying to fix!
    const result = await prisma.$executeRaw`UPDATE "Subject" SET stream = 'ALL' WHERE stream IS NULL`;
    
    console.log(`Successfully updated ${result} subjects with null streams to 'ALL'.`);
}

main()
    .catch((e) => {
        console.error('Migration failed:');
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        process.exit(0);
    });
