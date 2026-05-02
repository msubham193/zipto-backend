/**
 * One-time script to create demo accounts for Play Store review.
 *
 * Run: node scripts/create-demo-accounts.js
 *
 * After running:
 *  - Customer: demo.customer@zipto.com / Demo@2024
 *  - Driver:   demo.driver@zipto.com  / Demo@2024
 *              (must be approved in admin panel for MainTabs to open)
 */

const BASE_URL = 'https://api.ridezipto.com/api';

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log('Creating demo accounts on', BASE_URL);

  // ── Customer ─────────────────────────────────────────────────────────────
  console.log('\n[1/2] Creating demo customer...');
  const customer = await post('/auth/customer/email-register', {
    name: 'Demo Customer',
    email: 'demo.customer@zipto.com',
    password: 'Demo@2024',
  });
  if (customer.status === 201 || customer.status === 200) {
    console.log('  ✓ Customer created');
  } else if (customer.status === 409) {
    console.log('  ℹ Customer already exists — skipping');
  } else {
    console.error('  ✗ Failed:', customer.data);
  }

  // ── Driver ───────────────────────────────────────────────────────────────
  console.log('\n[2/2] Creating demo driver...');
  const driver = await post('/auth/driver/email-register', {
    name: 'Demo Driver',
    email: 'demo.driver@zipto.com',
    password: 'Demo@2024',
  });
  if (driver.status === 201 || driver.status === 200) {
    console.log('  ✓ Driver created');
    console.log('  ⚠  Go to the admin panel and APPROVE this driver so reviewers reach MainTabs');
  } else if (driver.status === 409) {
    console.log('  ℹ Driver already exists — skipping');
  } else {
    console.error('  ✗ Failed:', driver.data);
  }

  console.log('\nDone.\n');
  console.log('Play Store demo credentials');
  console.log('─────────────────────────────────────────');
  console.log('Customer app');
  console.log('  Email   : demo.customer@zipto.com');
  console.log('  Password: Demo@2024');
  console.log('');
  console.log('Rider app');
  console.log('  Email   : demo.driver@zipto.com');
  console.log('  Password: Demo@2024');
  console.log('  Note: approve this account in admin panel first!');
  console.log('─────────────────────────────────────────');
}

main().catch(console.error);
