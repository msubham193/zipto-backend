-- ============================================================
-- Zipto Production Migration
-- Run this once on the production PostgreSQL database
-- ============================================================

-- ── 1. Enum types ────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE driver_fraud_type AS ENUM (
    'delivery_abandoned',
    'sla_breach',
    'gps_ghost'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE driver_fraud_status AS ENUM (
    'suspected',
    'confirmed',
    'cleared'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE driver_fraud_detected_by AS ENUM (
    'socket_disconnect',
    'sla_deadline',
    'gps_cron'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE shield_transaction_type AS ENUM (
    'contribution',
    'withdrawal'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. driver_fraud_incidents ─────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_fraud_incidents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     UUID NOT NULL,
  driver_id      UUID NOT NULL,
  type           driver_fraud_type NOT NULL,
  status         driver_fraud_status NOT NULL DEFAULT 'suspected',
  detected_by    driver_fraud_detected_by NOT NULL,
  admin_notes    TEXT,
  resolved_by    UUID,
  resolved_at    TIMESTAMP,
  detected_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dfi_booking_id  ON driver_fraud_incidents (booking_id);
CREATE INDEX IF NOT EXISTS idx_dfi_driver_id   ON driver_fraud_incidents (driver_id);
CREATE INDEX IF NOT EXISTS idx_dfi_status      ON driver_fraud_incidents (status);

-- ── 3. zipto_shield_ledger ────────────────────────────────────

CREATE TABLE IF NOT EXISTS zipto_shield_ledger (
  id                VARCHAR(20) PRIMARY KEY DEFAULT 'zipto-shield',
  balance           DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_contributed DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_withdrawn   DECIMAL(14,2) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed the single ledger row if it doesn't exist
INSERT INTO zipto_shield_ledger (id, balance, total_contributed, total_withdrawn)
VALUES ('zipto-shield', 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ── 4. zipto_shield_transactions ──────────────────────────────

CREATE TABLE IF NOT EXISTS zipto_shield_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          shield_transaction_type NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(14,2) NOT NULL,
  booking_id    UUID,
  withdrawn_by  UUID,
  notes         TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zst_type       ON zipto_shield_transactions (type);
CREATE INDEX IF NOT EXISTS idx_zst_booking_id ON zipto_shield_transactions (booking_id);
CREATE INDEX IF NOT EXISTS idx_zst_created_at ON zipto_shield_transactions (created_at);

-- ── 5. New columns on bookings ────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS pickup_verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_flagged         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reason        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS flagged_at         TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_booking_is_flagged
  ON bookings (is_flagged);

CREATE INDEX IF NOT EXISTS idx_booking_driver_status
  ON bookings (driver_id, status);

CREATE INDEX IF NOT EXISTS idx_booking_customer_status
  ON bookings (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_booking_status_created
  ON bookings (status, booking_time);

CREATE INDEX IF NOT EXISTS idx_booking_ongoing_flagged
  ON bookings (status, is_flagged);

-- ── 6. New columns on driver_profiles ────────────────────────

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS wallet_frozen       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wallet_freeze_reason VARCHAR;

-- ── 7. Referral system ───────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE referrals_status_enum AS ENUM (
    'pending',
    'rewarded',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Each user's own shareable referral code
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
  ON users (referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id           UUID NOT NULL,
  referee_id            UUID NOT NULL UNIQUE,
  code                  VARCHAR(12) NOT NULL,
  status                referrals_status_enum NOT NULL DEFAULT 'pending',
  device_id             VARCHAR(128),
  referee_coins         INTEGER NOT NULL DEFAULT 0,
  referrer_coins        INTEGER NOT NULL DEFAULT 0,
  qualifying_booking_id UUID,
  rewarded_at           TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_referrals_referrer FOREIGN KEY (referrer_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_referrals_referee  FOREIGN KEY (referee_id)  REFERENCES users (id) ON DELETE CASCADE
);

-- device_id may be added later if the table already exists from an earlier run
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS device_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status      ON referrals (status);
CREATE INDEX IF NOT EXISTS idx_referrals_code        ON referrals (code);
CREATE INDEX IF NOT EXISTS idx_referrals_device_id   ON referrals (device_id);

-- Referral reward settings (admin-configurable via /admin/settings)
INSERT INTO system_settings (key, value, description)
VALUES
  ('referral_enabled',        'true', 'Master switch for the referral program'),
  ('referral_referee_coins',  '500',  'Coins credited to the new user (referee) after their first completed ride'),
  ('referral_referrer_coins', '1000', 'Coins credited to the referrer after their referee completes a first ride'),
  ('referral_share_base_url', 'https://api.ridezipto.com/refer', 'Base URL for referral share links (code appended: /refer/CODE)'),
  ('referral_banner_url',     'https://api.ridezipto.com/referral-banner.jpeg', 'Banner image shown as the WhatsApp/social link preview (og:image)'),
  ('referral_play_store_url', 'https://play.google.com/store/apps/details?id=com.ridezipto.customer', 'Play Store URL the referral landing page redirects to')
ON CONFLICT (key) DO NOTHING;

-- ── 8. Cashfree PG columns on payments ───────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS cashfree_order_id   VARCHAR(80),
  ADD COLUMN IF NOT EXISTS cashfree_payment_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_payments_cashfree_order_id
  ON payments (cashfree_order_id);

-- ── 9. Unified transaction ledger ────────────────────────────

CREATE TABLE IF NOT EXISTS transaction_logs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID,
  counterparty_user_id UUID,
  category             VARCHAR(40) NOT NULL,
  direction            VARCHAR(10) NOT NULL,
  amount               NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit                 VARCHAR(10) NOT NULL DEFAULT 'INR',
  status               VARCHAR(12) NOT NULL DEFAULT 'success',
  gateway              VARCHAR(20),
  gateway_ref          VARCHAR(120),
  booking_id           UUID,
  balance_after        NUMERIC(12,2),
  description          VARCHAR(255),
  metadata             JSONB,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txnlog_user_created  ON transaction_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txnlog_cat_created   ON transaction_logs (category, created_at);
CREATE INDEX IF NOT EXISTS idx_txnlog_gateway_ref   ON transaction_logs (gateway_ref);
CREATE INDEX IF NOT EXISTS idx_txnlog_booking_id    ON transaction_logs (booking_id);
CREATE INDEX IF NOT EXISTS idx_txnlog_status        ON transaction_logs (status);
CREATE INDEX IF NOT EXISTS idx_txnlog_created_at    ON transaction_logs (created_at);

-- ── 10. Cashfree Payouts beneficiary columns on driver bank accounts ──

ALTER TABLE driver_bank_accounts
  ADD COLUMN IF NOT EXISTS cashfree_beneficiary_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS cashfree_sync_status    VARCHAR(20) DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_bank_accounts_cf_beneficiary
  ON driver_bank_accounts (cashfree_beneficiary_id);

-- ── Done ──────────────────────────────────────────────────────
SELECT 'Migration complete' AS result;
