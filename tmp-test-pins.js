const axios = require('axios');

async function testPins() {
  const api = axios.create({
    baseURL: 'http://localhost:5000/api/v1',
    withCredentials: true
  });

  try {
    // 1. Login
    const loginRes = await api.post('/auth/login', {
      loginId: 'emai@gmail.com',
      password: 'password123', // I will assume standard test password or I can bypass
      role: 'ADMIN',
      schoolCode: '673340'     // from ST James
    });
    
    const cookieHeader = loginRes.headers['set-cookie'];
    if (cookieHeader) {
      api.defaults.headers.Cookie = cookieHeader.join('; ');
    }
    
    console.log('Login successful');

    // 2. Fetch Batches
    const batchesRes = await api.get('/pins/batches');
    console.log('Batches Response:', JSON.stringify(batchesRes.data, null, 2));
    
  } catch (error) {
    console.error('Test Failed:', error.response ? error.response.data : error.message);
  }
}

testPins();
