require('dotenv').config();
const prisma = require('./db/prisma');
const util = require('util');

async function test() {
    try {
        const t = await prisma.paymentTransaction.create({
            data: {
                schoolId: "test-school",
                studentId: "test-student",
                reference: "TEST-REF-123",
                amount: 5000,
                method: "PAYSTACK"
            }
        });
        console.log(t);
    } catch(err) {
        console.error(err);
    }
}
test();
