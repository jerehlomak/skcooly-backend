import http from 'http';

const loginAndFetchDashboard = async (loginId, password, role) => {
    try {
        console.log(`Testing Login for ${loginId} as ${role}...`);

        const loginOptions = {
            hostname: 'localhost',
            port: 5000,
            path: '/api/v1/auth/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        };

        const loginReq = http.request(loginOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.error(`[${role}] Login Failed:`, data);
                    return;
                }

                const cookies = res.headers['set-cookie'];
                if (!cookies || cookies.length === 0) {
                    console.error(`[${role}] No cookies returned on login!`);
                    return;
                }

                console.log(`[${role}] Login Success. Fetching Dashboard...`);

                const dashOptions = {
                    hostname: 'localhost',
                    port: 5000,
                    path: '/api/v1/dashboard/me',
                    method: 'GET',
                    headers: {
                        'Cookie': cookies[0]
                    }
                };

                const dashReq = http.request(dashOptions, (dashRes) => {
                    let dashData = '';
                    dashRes.on('data', (chunk) => dashData += chunk);
                    dashRes.on('end', () => {
                        console.log(`\n--- Dashboard Result for ${role} (${loginId}) ---`);
                        console.log(`Status: ${dashRes.statusCode}`);
                        try {
                            console.log(JSON.stringify(JSON.parse(dashData), null, 2));
                        } catch (e) {
                            console.log(dashData);
                        }
                    });
                });
                dashReq.on('error', console.error);
                dashReq.end();
            });
        });

        loginReq.on('error', console.error);
        loginReq.write(JSON.stringify({ loginId, password, role }));
        loginReq.end();

    } catch (error) {
        console.error('Script Error:', error);
    }
};

loginAndFetchDashboard('admin@eschool.com', 'password123', 'ADMIN');
setTimeout(() => loginAndFetchDashboard('parent@eschool.com', 'password123', 'PARENT'), 2000);
setTimeout(() => loginAndFetchDashboard('student@eschool.com', 'password123', 'STUDENT'), 4000);
setTimeout(() => loginAndFetchDashboard('teacher@eschool.com', 'password123', 'TEACHER'), 6000);
