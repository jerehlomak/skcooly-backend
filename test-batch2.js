const axios = require('axios');
const fs = require('fs');

(async () => {
    try {
        const loginRes = await axios.post('http://localhost:5000/api/v1/auth/login', {
            email: 'admin@skooly.com', // guess
            password: 'password' // guess
        });
        const cookie = loginRes.headers['set-cookie'];
        
        const classRes = await axios.get('http://localhost:5000/api/v1/classes', {
            headers: { Cookie: cookie }
        });
        const classId = classRes.data.classes[0].id;
        
        // Let's find students in this class
        const studentsRes = await axios.get(`http://localhost:5000/api/v1/classes/${classId}/students`, {
            headers: { Cookie: cookie }
        });
        let studentIds = studentsRes.data.students.map(s => s.id);
        if (studentIds.length === 0) {
             const allRes = await axios.get(`http://localhost:5000/api/v1/students`, { headers: { Cookie: cookie }});
             studentIds = [allRes.data.students[0].id];
        }
        
        console.log(`Printing for ${studentIds.length} students...`);
        
        const printRes = await axios.post('http://localhost:5000/api/v1/results/print/batch', {
            studentIds: studentIds,
            classId: classId,
            term: "First Term",
            academicYear: "2023/2024",
            resultType: "FULL",
            format: "single"
        }, {
            headers: { Cookie: cookie },
            responseType: 'arraybuffer'
        });

        fs.writeFileSync('batch_output.pdf', printRes.data);
        console.log('SUCCESS');
    } catch (e) {
        console.error('Test failed:', e.message);
        if (e.response && e.response.data) {
            console.error(e.response.data.toString());
        }
    }
})();
