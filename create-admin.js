const { Client } = require('pg');
const bcrypt = require('bcryptjs');

async function createAdminUser() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'skido_user',
    password: 'msubham193',
    database: 'skido_db',
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Check if admin already exists
    const checkResult = await client.query(
      `SELECT * FROM users WHERE email = $1 OR (role = 'admin' AND phone = $2)`,
      ['admin@skido.com', '9999999999']
    );

    if (checkResult.rows.length > 0) {
      console.log('\n⚠️  Admin user already exists!');
      console.log('Existing admin:', checkResult.rows[0]);
      
      // Update the existing admin with correct password
      const passwordHash = await bcrypt.hash('Admin@123', 10);
      await client.query(
        `UPDATE users 
         SET email = $1, password_hash = $2, is_verified = true, is_active = true, updated_at = NOW()
         WHERE id = $3`,
        ['admin@skido.com', passwordHash, checkResult.rows[0].id]
      );
      console.log('\n✅ Updated existing admin user with email and password');
    } else {
      // Create new admin user
      const passwordHash = await bcrypt.hash('Admin@123', 10);
      
      const result = await client.query(
        `INSERT INTO users (phone, email, name, role, is_verified, is_active, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        ['9999999999', 'admin@skido.com', 'Admin User', 'admin', true, true, passwordHash]
      );

      console.log('\n✅ Admin user created successfully!');
      console.log('Admin details:', {
        id: result.rows[0].id,
        email: result.rows[0].email,
        phone: result.rows[0].phone,
        name: result.rows[0].name,
        role: result.rows[0].role,
      });
    }

    console.log('\n📋 Login Credentials:');
    console.log('Email: admin@skido.com');
    console.log('Password: Admin@123');
    console.log('\n🔗 Login endpoint: POST /api/auth/admin/login');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await client.end();
    console.log('\n✅ Database connection closed');
  }
}

createAdminUser().catch(console.error);
