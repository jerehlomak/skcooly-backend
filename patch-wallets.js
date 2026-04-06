const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Fetching wallets missing branchId...');
  const wallets = await prisma.studentWallet.findMany({
    where: { branchId: null },
    include: { student: true }
  });

  if (wallets.length === 0) {
    console.log('No wallets missing branchId found.');
    return;
  }

  console.log(`Found ${wallets.length} wallets. Updating...`);
  
  let count = 0;
  for (const wallet of wallets) {
    if (wallet.student && wallet.student.branchId) {
      await prisma.studentWallet.update({
        where: { id: wallet.id },
        data: { branchId: wallet.student.branchId }
      });
      count++;
    }
  }

  console.log(`Successfully backfilled branchId for ${count} wallets.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
