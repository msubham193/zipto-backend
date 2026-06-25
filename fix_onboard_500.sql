-- ============================================================================
-- HOTFIX: rider "Internal Server Error" on document submission (POST /driver/onboard)
-- ============================================================================
-- Cause: two columns were added to driver_profiles in recent releases:
--   • last_location_at  (dispatch freshness — commit 618b840)
--   • rejection_reason  (KYC reject reason — commit e2c2b48)
-- When a NEW driver submits documents, TypeORM INSERTs the full driver_profiles
-- row, including these columns. On a database where they don't exist (synchronize
-- OFF + migration not run) the INSERT fails → 500. It works on any DB with
-- DATABASE_SYNCHRONIZE=true because TypeORM auto-creates them on boot.
--
-- This script is idempotent (safe to run repeatedly). Run it against the
-- affected database, then retry document submission.
-- ============================================================================

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_driver_last_location_at
  ON driver_profiles (last_location_at);

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL;

-- Sanity check — should list both columns:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'driver_profiles'
--    AND column_name IN ('last_location_at', 'rejection_reason');
