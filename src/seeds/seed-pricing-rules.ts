/**
 * Seed script for default pricing rules (Odisha / Porter-style rates)
 *
 * Usage:
 *   npx ts-node src/seeds/seed-pricing-rules.ts
 *
 * Or run with: node -r ts-node/register src/seeds/seed-pricing-rules.ts
 */

const { Client } = require('pg');
require('dotenv').config();

const pricingRules = [
  {
    vehicle_type: 'bike',
    base_fare: 30,
    base_distance_km: 2,
    per_km_rate: 10,
    per_minute_rate: 1.5,
    minimum_fare: 30,
    surge_multiplier: 1.0,
    free_waiting_minutes: 70,
    waiting_charge_per_minute: 1.5,
    night_surcharge_percent: 15,
    multi_stop_fee: 20,
    helper_charge_per_person: 0,
    commission_percent: 30,
    city: 'Bhubaneswar',
  },
  {
    vehicle_type: 'three_wheeler',
    base_fare: 50,
    base_distance_km: 2,
    per_km_rate: 14,
    per_minute_rate: 2.0,
    minimum_fare: 50,
    surge_multiplier: 1.0,
    free_waiting_minutes: 70,
    waiting_charge_per_minute: 2.0,
    night_surcharge_percent: 15,
    multi_stop_fee: 25,
    helper_charge_per_person: 200,
    commission_percent: 30,
    city: 'Bhubaneswar',
  },
  {
    vehicle_type: 'tata_ace',
    base_fare: 120,
    base_distance_km: 2,
    per_km_rate: 16,
    per_minute_rate: 2.0,
    minimum_fare: 120,
    surge_multiplier: 1.0,
    free_waiting_minutes: 70,
    waiting_charge_per_minute: 2.0,
    night_surcharge_percent: 15,
    multi_stop_fee: 30,
    helper_charge_per_person: 300,
    commission_percent: 30,
    city: 'Bhubaneswar',
  },
  {
    vehicle_type: 'pickup_8ft',
    base_fare: 200,
    base_distance_km: 2,
    per_km_rate: 20,
    per_minute_rate: 2.5,
    minimum_fare: 200,
    surge_multiplier: 1.0,
    free_waiting_minutes: 70,
    waiting_charge_per_minute: 2.5,
    night_surcharge_percent: 15,
    multi_stop_fee: 40,
    helper_charge_per_person: 300,
    commission_percent: 30,
    city: 'Bhubaneswar',
  },
  {
    vehicle_type: 'tata_407',
    base_fare: 350,
    base_distance_km: 2,
    per_km_rate: 24,
    per_minute_rate: 3.0,
    minimum_fare: 350,
    surge_multiplier: 1.0,
    free_waiting_minutes: 70,
    waiting_charge_per_minute: 3.0,
    night_surcharge_percent: 15,
    multi_stop_fee: 50,
    helper_charge_per_person: 300,
    commission_percent: 30,
    city: 'Bhubaneswar',
  },
];

async function seed() {
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'skido_db',
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    for (const rule of pricingRules) {
      // Check if active rule already exists for this vehicle type & city
      const existing = await client.query(
        `SELECT id FROM pricing_rules WHERE vehicle_type = $1 AND city = $2 AND is_active = true`,
        [rule.vehicle_type, rule.city],
      );

      if (existing.rows.length > 0) {
        // Update existing rule
        await client.query(
          `UPDATE pricing_rules SET
            base_fare = $1, base_distance_km = $2, per_km_rate = $3, per_minute_rate = $4,
            minimum_fare = $5, surge_multiplier = $6, free_waiting_minutes = $7,
            waiting_charge_per_minute = $8, night_surcharge_percent = $9,
            multi_stop_fee = $10, helper_charge_per_person = $11, commission_percent = $12,
            updated_at = NOW()
          WHERE id = $13`,
          [
            rule.base_fare,
            rule.base_distance_km,
            rule.per_km_rate,
            rule.per_minute_rate,
            rule.minimum_fare,
            rule.surge_multiplier,
            rule.free_waiting_minutes,
            rule.waiting_charge_per_minute,
            rule.night_surcharge_percent,
            rule.multi_stop_fee,
            rule.helper_charge_per_person,
            rule.commission_percent,
            existing.rows[0].id,
          ],
        );
        console.log(`🔄 Updated pricing rule for ${rule.vehicle_type} (${rule.city})`);
      } else {
        // Insert new rule
        await client.query(
          `INSERT INTO pricing_rules (
            vehicle_type, base_fare, base_distance_km, per_km_rate, per_minute_rate,
            minimum_fare, surge_multiplier, free_waiting_minutes, waiting_charge_per_minute,
            night_surcharge_percent, multi_stop_fee, helper_charge_per_person,
            commission_percent, city, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true)`,
          [
            rule.vehicle_type,
            rule.base_fare,
            rule.base_distance_km,
            rule.per_km_rate,
            rule.per_minute_rate,
            rule.minimum_fare,
            rule.surge_multiplier,
            rule.free_waiting_minutes,
            rule.waiting_charge_per_minute,
            rule.night_surcharge_percent,
            rule.multi_stop_fee,
            rule.helper_charge_per_person,
            rule.commission_percent,
            rule.city,
          ],
        );
        console.log(`✅ Created pricing rule for ${rule.vehicle_type} (${rule.city})`);
      }
    }

    console.log('\n🎉 All pricing rules seeded successfully!');
    console.log('\nDefault rates:');
    console.log('┌───────────────┬───────────┬──────────┬────────────┬───────────┐');
    console.log('│ Vehicle       │ Base Fare │ Per KM   │ Per Min    │ Min Fare  │');
    console.log('├───────────────┼───────────┼──────────┼────────────┼───────────┤');
    for (const rule of pricingRules) {
      console.log(
        `│ ${rule.vehicle_type.padEnd(13)} │ ₹${String(rule.base_fare).padEnd(8)} │ ₹${String(rule.per_km_rate).padEnd(7)} │ ₹${String(rule.per_minute_rate).padEnd(9)} │ ₹${String(rule.minimum_fare).padEnd(8)} │`,
      );
    }
    console.log('└───────────────┴───────────┴──────────┴────────────┴───────────┘');
  } catch (error) {
    console.error('❌ Error seeding pricing rules:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
