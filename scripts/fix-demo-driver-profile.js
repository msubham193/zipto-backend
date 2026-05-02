/**
 * One-time fix: creates a pending DriverProfile for demo.driver@zipto.com
 * if one doesn't already exist.
 *
 * Run: node scripts/fix-demo-driver-profile.js
 */

require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host:     process.env.DATABASE_HOST     || 'localhost',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  user:     process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME     || 'skido_db',
});

async function main() {
  await client.connect();

  // Find demo driver user
  const userRes = await client.query(
    `SELECT id FROM users WHERE email = $1 AND role = 'driver' LIMIT 1`,
    ['demo.driver@zipto.com'],
  );

  if (userRes.rowCount === 0) {
    console.error('✗ demo.driver@zipto.com not found in users table.');
    process.exit(1);
  }

  const userId = userRes.rows[0].id;
  console.log(`✓ Found driver user: ${userId}`);

  // Check if profile already exists
  const profileRes = await client.query(
    `SELECT id FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

  if (profileRes.rowCount > 0) {
    console.log('ℹ DriverProfile already exists — nothing to do.');
    console.log('  If still not showing in admin, check admin panel filter (might need page refresh).');
    await client.end();
    return;
  }

  // Create pending driver profile
  await client.query(
    `INSERT INTO driver_profiles (user_id, verification_status, availability_status)
     VALUES ($1, 'pending', 'offline')`,
    [userId],
  );

  console.log('✓ DriverProfile created with status = pending');
  console.log('  Go to admin panel → Drivers → approve demo.driver@zipto.com');

  await client.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
