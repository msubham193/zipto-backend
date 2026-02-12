const http = require('http');

async function testPort(port) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: '/api/auth/admin/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 2000
    };

    const data = JSON.stringify({
      email: 'admin@skido.com',
      password: 'Admin@123'
    });

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        resolve({
          port,
          status: res.statusCode,
          success: res.statusCode === 200 || res.statusCode === 201,
          response: responseData
        });
      });
    });

    req.on('error', () => {
      resolve({ port, status: 'error', success: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ port, status: 'timeout', success: false });
    });

    req.write(data);
    req.end();
  });
}

async function findBackendPort() {
  console.log('🔍 Searching for backend API on common ports...\n');
  
  const ports = [3000, 3001, 3002, 3003, 4000, 5000, 8000, 8080];
  
  for (const port of ports) {
    process.stdout.write(`Testing port ${port}... `);
    const result = await testPort(port);
    
    if (result.success) {
      console.log(`✅ FOUND!`);
      console.log(`\n🎉 Backend API is running on port ${port}`);
      console.log('Response:', result.response.substring(0, 200));
      return;
    } else if (result.status === 404) {
      console.log(`❌ 404 (server running but route not found)`);
    } else if (result.status === 401) {
      console.log(`🔒 401 (auth endpoint exists but credentials invalid)`);
    } else {
      console.log(`⚠️  ${result.status}`);
    }
  }
  
  console.log('\n❌ Backend API not found on any common port');
}

findBackendPort();
