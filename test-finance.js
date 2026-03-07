const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const tokenUser = { name: 'Test Admin', userId: '1', role: 'ADMIN' };
const token = jwt.sign(tokenUser, process.env.JWT_SECRET, { expiresIn: '1d' });
const crypto = require('crypto');
const sign = (val, secret) => 's:' + val + '.' + crypto.createHmac('sha256', secret).update(val).digest('base64').replace(/\=+$/, '');
const signedToken = sign(token, process.env.JWT_SECRET);

const headers = { Cookie: `token=${signedToken}` };

async function seed() {
    try {
        console.log('Seeding fake teacher and student...');

        // 1. Create a Teacher
        const tReq = await axios.post('http://localhost:5000/api/v1/auth/register', {
            name: 'Mr. John Doe (Teacher)',
            email: 'john' + Date.now() + '@school.com',
            password: 'password123',
            role: 'TEACHER'
        });
        const tId = tReq.data.user.id;

        await axios.post('http://localhost:5000/api/v1/teachers', {
            userId: tId,
            employeeId: 'EMP' + Date.now(),
            department: 'Sciences',
            gender: 'Male',
            salary: 200000,
            bankName: '044', // Access Bank
            accountNumber: '0690000031' // FW Test Account
        }, { headers });

        console.log('Teacher Seeded.');

        // 2. Create a Student
        const sReq = await axios.post('http://localhost:5000/api/v1/auth/register', {
            name: 'Jane Smith (Student)',
            email: 'jane' + Date.now() + '@school.com',
            password: 'password123',
            role: 'STUDENT'
        });
        const sId = sReq.data.user.id;

        await axios.post('http://localhost:5000/api/v1/students', {
            userId: sId,
            admissionNo: 'ADM' + Date.now(),
            classLevel: 'SS1',
            gender: 'Female',
            status: 'Active'
        }, { headers });

        console.log('Student Seeded.');

        // 3. Re-run our finance tests
        console.log('\n--- Triggering E2E Tests ---');

        // SALARY TEST
        const salGet = await axios.get('http://localhost:5000/api/v1/finance/salaries', { headers });
        console.log('Salaries Fetched:', salGet.data.payroll.length);
        if (salGet.data.payroll.length > 0) {
            const slip = salGet.data.payroll[0];
            const payRes = await axios.post('http://localhost:5000/api/v1/finance/salaries', { slipId: slip.id, gateway: 'Flutterwave' }, { headers });
            console.log('Salary Paid! TX Ref:', payRes.data.slip.paymentReference);
        }

        // FEES TEST
        const feeGet = await axios.get('http://localhost:5000/api/v1/finance/fees', { headers });
        console.log('Fees Fetched:', feeGet.data.fees.length);
        if (feeGet.data.fees.length > 0) {
            const bill = feeGet.data.fees[0];
            const feePost = await axios.post('http://localhost:5000/api/v1/finance/fees', { invoiceId: bill.id, amount: 50000, paymentMethod: 'Remita' }, { headers });
            console.log('Fee Collected (Partial)! Remita RRR:', feePost.data.gatewayData.rrr);
        }

        // LEDGER TEST
        const ledgGet = await axios.get('http://localhost:5000/api/v1/finance/ledger', { headers });
        console.log('Ledger Transactions:', ledgGet.data.transactions.length);
        ledgGet.data.transactions.slice(0, 2).forEach(t => console.log(` -> ${t.type.toUpperCase()}: ${t.description} | NGN ${t.amount} (${t.gateway})`));

    } catch (e) {
        console.log('Error:', e.response?.data || e.message);
    }
}
seed();
