const axios = require('axios');

async function test() {
    try {
        // Need to hit the endpoint as an authenticated user...
        // But since we are bypassing, let me just login as Admin first
        const loginRes = await axios.post('http://localhost:5000/api/v1/auth/login', {
            email: 'admin@cornerstone.com', // Let's guess
            password: 'password123'
        });
    } catch(err) {
        console.error(err.response ? err.response.data : err.message);
    }
}
test();
