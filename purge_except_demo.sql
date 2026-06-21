-- ============================================================================
-- PURGE ALL DRIVERS & CUSTOMERS EXCEPT THE TWO DEMO ACCOUNTS
-- ============================================================================
-- Keeps ONLY:
--   • Driver   — Anil Tripathi        phone 6371171553
--   • Customer — Ashwini Kumar Sahu   phone 7735416582 / demo@gmail.com
--   • ALL admin accounts (never deleted)
-- Everything else (every other driver/customer ACCOUNT + all their bookings,
-- payments, wallet, ratings, withdrawals, topups, reports, tickets, referrals,
-- coin/shield ledger rows, profiles, vehicles, bank accounts) is DELETED.
--
-- ⚠️  IRREVERSIBLE. TAKE A BACKUP FIRST (run this in the shell, NOT in psql):
--
--     pg_dump -U <DATABASE_USERNAME> -h localhost <DATABASE_NAME> \
--       -Fc -f ~/zipto_backup_$(date +%F_%H%M).dump
--
--   (credentials are in /var/www/zipto-backend/.env — DATABASE_USERNAME / NAME)
--
-- HOW TO RUN:
--   psql -U <DATABASE_USERNAME> -h localhost -d <DATABASE_NAME> -f purge_except_demo.sql
--
-- DRY RUN FIRST (strongly recommended): change the final `COMMIT;` to `ROLLBACK;`
--   then run once — you'll see the "to be deleted" counts WITHOUT changing data.
--   When the counts look right, switch it back to `COMMIT;` and run again.
-- ============================================================================

BEGIN;

-- Accounts we KEEP. Phone match is format-agnostic (last 10 digits).
CREATE TEMP TABLE keep_users ON COMMIT DROP AS
  SELECT id FROM users
   WHERE role = 'admin'
      OR right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)
            IN ('6371171553', '7735416582')
      OR lower(coalesce(email, '')) = 'demo@gmail.com';

-- Bookings to remove = any booking touching a non-kept user (as customer or
-- driver). A booking survives only if BOTH parties are kept (e.g. demo↔demo).
CREATE TEMP TABLE rm_bookings ON COMMIT DROP AS
  SELECT id FROM bookings
   WHERE customer_id NOT IN (SELECT id FROM keep_users)
      OR (driver_id IS NOT NULL AND driver_id NOT IN (SELECT id FROM keep_users));

-- Driver profiles belonging to removable users.
CREATE TEMP TABLE rm_profiles ON COMMIT DROP AS
  SELECT id FROM driver_profiles WHERE user_id NOT IN (SELECT id FROM keep_users);

-- ── Preview: what will be kept / removed ──────────────────────────────────
\echo '--- KEEPING these users: ---'
SELECT id, name, phone, email, role FROM users WHERE id IN (SELECT id FROM keep_users) ORDER BY role;
\echo '--- Counts to be DELETED: ---'
SELECT
  (SELECT count(*) FROM users        WHERE id  NOT IN (SELECT id FROM keep_users)) AS users_to_delete,
  (SELECT count(*) FROM bookings     WHERE id  IN     (SELECT id FROM rm_bookings)) AS bookings_to_delete,
  (SELECT count(*) FROM driver_profiles WHERE id IN  (SELECT id FROM rm_profiles)) AS driver_profiles_to_delete;

-- ── 1. Rows hanging off removable bookings / users (FK children first) ─────
DELETE FROM payments               WHERE booking_id::text IN (SELECT id::text FROM rm_bookings);

DELETE FROM ratings                WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR customer_id NOT IN (SELECT id FROM keep_users)
                                      OR driver_id   NOT IN (SELECT id FROM keep_users);

DELETE FROM coin_transactions      WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR user_id NOT IN (SELECT id FROM keep_users);

DELETE FROM zipto_shield_transactions WHERE booking_id::text IN (SELECT id::text FROM rm_bookings);

DELETE FROM driver_fraud_incidents WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR driver_id NOT IN (SELECT id FROM keep_users);

DELETE FROM customer_reports       WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR customer_id  NOT IN (SELECT id FROM keep_users)
                                      OR reported_by  NOT IN (SELECT id FROM keep_users);

DELETE FROM coupon_usages          WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR user_id NOT IN (SELECT id FROM keep_users);

DELETE FROM transaction_logs       WHERE booking_id::text IN (SELECT id::text FROM rm_bookings)
                                      OR user_id              NOT IN (SELECT id FROM keep_users)
                                      OR counterparty_user_id NOT IN (SELECT id FROM keep_users);

-- Support tickets + their messages
DELETE FROM ticket_messages
  WHERE sender_id NOT IN (SELECT id FROM keep_users)
     OR ticket_id IN (
        SELECT id FROM support_tickets
         WHERE customer_id NOT IN (SELECT id FROM keep_users)
            OR booking_id::text IN (SELECT id::text FROM rm_bookings));
DELETE FROM support_tickets
  WHERE customer_id NOT IN (SELECT id FROM keep_users)
     OR booking_id::text IN (SELECT id::text FROM rm_bookings);

-- Referrals: drop those involving a removable user; unlink removable bookings
-- from any surviving (demo↔demo) referral.
DELETE FROM referrals WHERE referrer_id NOT IN (SELECT id FROM keep_users)
                         OR referee_id  NOT IN (SELECT id FROM keep_users);
UPDATE referrals SET qualifying_booking_id = NULL
  WHERE qualifying_booking_id::text IN (SELECT id::text FROM rm_bookings);

-- ── 2. Driver-scoped tables (BEFORE bookings — some carry a booking_id) ───
-- Includes a kept driver's (Anil's) wallet rows that point at a removable
-- booking, so the bookings DELETE below isn't blocked by an FK.
DELETE FROM driver_wallet_transactions  WHERE driver_user_id NOT IN (SELECT id FROM keep_users)
                                           OR booking_id::text IN (SELECT id::text FROM rm_bookings);
DELETE FROM driver_topup_requests       WHERE driver_user_id NOT IN (SELECT id FROM keep_users);
DELETE FROM driver_withdrawal_requests  WHERE driver_profile_id IN (SELECT id FROM rm_profiles);
DELETE FROM driver_bank_accounts        WHERE driver_profile_id IN (SELECT id FROM rm_profiles);

-- ── 3. Customer-scoped tables ─────────────────────────────────────────────
DELETE FROM wallet_transactions WHERE user_id NOT IN (SELECT id FROM keep_users);
DELETE FROM user_blocks         WHERE customer_id NOT IN (SELECT id FROM keep_users)
                                   OR blocked_by  NOT IN (SELECT id FROM keep_users);

-- ── 4. Bookings themselves (after their children; BEFORE vehicles) ────────
-- Detach any reassignment pointer to a removable driver on surviving bookings.
UPDATE bookings SET original_driver_id = NULL
  WHERE original_driver_id IS NOT NULL
    AND original_driver_id NOT IN (SELECT id FROM keep_users);
DELETE FROM bookings WHERE id IN (SELECT id FROM rm_bookings);

-- ── 5. Vehicles + profiles ────────────────────────────────────────────────
-- bookings.vehicle_id references vehicles, so vehicles must go AFTER bookings.
DELETE FROM vehicles          WHERE driver_id IN (SELECT id FROM rm_profiles);
DELETE FROM driver_profiles   WHERE user_id NOT IN (SELECT id FROM keep_users);
DELETE FROM customer_profiles WHERE user_id NOT IN (SELECT id FROM keep_users);

-- ── 6. Finally, the user accounts ─────────────────────────────────────────
DELETE FROM users WHERE id NOT IN (SELECT id FROM keep_users);

-- ── Verify what remains ───────────────────────────────────────────────────
\echo '--- REMAINING users after purge: ---'
SELECT id, name, phone, email, role FROM users ORDER BY role, name;
SELECT count(*) AS remaining_users, count(*) FILTER (WHERE role='driver') AS drivers,
       count(*) FILTER (WHERE role='customer') AS customers,
       count(*) FILTER (WHERE role='admin') AS admins
  FROM users;

-- Change to ROLLBACK; for a dry run (prints counts, deletes nothing).
COMMIT;
