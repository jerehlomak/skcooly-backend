const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.commentRule.findMany().then(console.log).finally(() => prisma.$disconnect());
