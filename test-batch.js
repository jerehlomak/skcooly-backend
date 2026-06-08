const axios = require('axios');
const fs = require('fs');

(async () => {
    try {
        // 1. Login to get token
        const loginRes = await axios.post('http://localhost:5000/api/v1/auth/login', {
            email: 'admin@skooly.com', // guess
            password: 'password' // guess
        });
        const cookie = loginRes.headers['set-cookie'];
        console.log('Logged in!');

        // 2. Fetch class ID to test
        const classRes = await axios.get('http://localhost:5000/api/v1/classes', {
            headers: { Cookie: cookie }
        });
        const classId = classRes.data.classes[0].id;

        // 3. Trigger print batch
        const printRes = await axios.post('http://localhost:5000/api/v1/results/print/batch', {
            studentIds: ["123"], // fake
            classId: classId,
            term: "First Term",
            academicYear: "2023/2024",
            resultType: "FULL",
            format: "single"
        }, {
            headers: { Cookie: cookie },
            responseType: 'arraybuffer'
        });

        console.log('Print succeeded, size:', printRes.data.length);
    } catch (e) {
        console.error('Test failed:', e.response?.data || e.message);
    }
})();
