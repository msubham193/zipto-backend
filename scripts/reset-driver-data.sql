-- ============================================================
-- DRIVER DATA RESET SCRIPT
-- Resets: wallet balances, trip counts, all transactions,
--         all bookings, payments, and withdrawal records.
--
-- ⚠️  IRREVERSIBLE — run only on test/staging or with a backup.
-- Run on the production server:
--   psql $DATABASE_URL -f scripts/reset-driver-data.sql
-- ============================================================

BEGIN;

-- 1. Clear wallet transaction ledger
DELETE FROM driver_wallet_transactions;

-- 2. Clear topup requests
DELETE FROM driver_topup_requests;

-- 3. Clear withdrawal requests
DELETE FROM driver_withdrawal_requests;

-- 4. Reset wallet balances and trip counters on all driver profiles
UPDATE driver_profiles
SET
  wallet_balance = 0,
  total_trips    = 0;

-- 5. Clear all payments
DELETE FROM payments;

-- 6. Clear all bookings (cascade deletes booking-related records)
DELETE FROM bookings;

-- 7. Clear ratings
DELETE FROM ratings;

COMMIT;

-- Verify
SELECT COUNT(*) AS driver_profiles FROM driver_profiles;
SELECT COUNT(*) AS wallet_txns      FROM driver_wallet_transactions;
SELECT COUNT(*) AS bookings          FROM bookings;
SELECT SUM(wallet_balance) AS total_wallet FROM driver_profiles;
