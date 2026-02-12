const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/docs-json',
  method: 'GET',
};

console.log('📚 Fetching Swagger documentation...\n');

const req = http.request(options, (res) => {
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    
    if (res.statusCode === 200) {
      try {
        const swagger = JSON.parse(responseData);
        console.log('\n✅ Available routes:\n');
        
        // Find auth routes
        const authRoutes = Object.keys(swagger.paths || {}).filter(path => path.includes('auth'));
        
        if (authRoutes.length > 0) {
          console.log('Auth routes found:');
          authRoutes.forEach(route => {
            const methods = Object.keys(swagger.paths[route]);
            console.log(`  ${methods.join(', ').toUpperCase()} ${route}`);
          });
        } else {
          console.log('❌ No auth routes found!');
          console.log('\nAll available routes:');
          Object.keys(swagger.paths || {}).slice(0, 20).forEach(route => {
            const methods = Object.keys(swagger.paths[route]);
            console.log(`  ${methods.join(', ').toUpperCase()} ${route}`);
          });
        }
      } catch (e) {
        console.log('Error parsing response:', e.message);
        console.log(responseData.substring(0, 500));
      }
    } else {
      console.log('Response:', responseData);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request error:', error.message);
});

req.end();
