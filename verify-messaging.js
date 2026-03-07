const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.message.count()
    .then(c => { console.log('Message table OK, count:', c); return p.smsLog.count(); })
    .then(c => { console.log('SmsLog table OK, count:', c); p.$disconnect(); })
    .catch(e => console.error('Error:', e.message));
