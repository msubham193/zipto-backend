#!/usr/bin/env node
/**
 * Script to create admin user on EC2 instance
 * Run this on your EC2 server after deployment
 */

const { Client } = require('pg');
const bcrypt = require('bcryptjs');

async function createAdminUser() {
  // Read database config from environment variables
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'skido_db',
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');
    console.log(`   Host: ${client.host}:${client.port}`);
    console.log(`   Database: ${client.database}\n`);

    // Check if admin already exists
    const checkResult = await client.query(
      `SELECT * FROM users WHERE email = $1 OR (role = 'admin' AND phone = $2)`,
      ['admin@skido.com', '9999999999']
    );

    if (checkResult.rows.length > 0) {
      console.log('⚠️  Admin user already exists!');
      console.log('Existing admin:', {
        id: checkResult.rows[0].id,
        email: checkResult.rows[0].email,
        phone: checkResult.rows[0].phone,
        name: checkResult.rows[0].name,
      });
      
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
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Email:    admin@skido.com');
    console.log('Password: Admin@123');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n🔗 Login endpoint: POST /api/auth/admin/login\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Make sure PostgreSQL is running and accessible');
    } else if (error.code === '42P01') {
      console.error('\n💡 The users table does not exist. Run migrations first:');
      console.error('   npm run migration:run');
    }
    process.exit(1);
  } finally {
    await client.end();
    console.log('✅ Database connection closed\n');
  }
}

createAdminUser().catch(console.error);
