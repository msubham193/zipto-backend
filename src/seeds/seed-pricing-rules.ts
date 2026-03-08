/**
 * Seed script for default pricing rules (Odisha / Porter-style rates)
 *
 * Usage:
 *   npx ts-node src/seeds/seed-pricing-rules.ts
 *
 * Or run with: node -r ts-node/register src/seeds/seed-pricing-rules.ts
 */

import {
  DEFAULT_PRICING_CITY,
  getDefaultPricingRules,
  LEGACY_VEHICLE_TYPES,
} from '../modules/booking/constants/default-pricing-rules';

const { Client } = require('pg');
require('dotenv').config();

const pricingRules = getDefaultPricingRules(DEFAULT_PRICING_CITY);

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

    await client.query(
      `UPDATE pricing_rules
       SET is_active = false, updated_at = NOW()
       WHERE city = $1 AND vehicle_type = ANY($2)`,
      [DEFAULT_PRICING_CITY, LEGACY_VEHICLE_TYPES],
    );

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
