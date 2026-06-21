-- ============================================================================
-- RECOMPUTE GST SPLIT ON EXISTING BOOKINGS
-- ============================================================================
-- Fixes bookings created BEFORE the CGST/SGST rounding fix, which stored an
-- uneven split (e.g. ₹40 @ 18% → CGST 4 + SGST 3) instead of computing each
-- half independently (CGST 3.60 + SGST 3.60 = 7.20). Re-foots the totals too.
--
-- Only touches bookings that already have GST (gst_amount > 0).
--
-- DRY RUN: change the final COMMIT; to ROLLBACK; — prints before/after, no change.
-- RUN:     psql -U skido_user -h localhost -d skido_db -f fix_gst_split.sql
-- ============================================================================

BEGIN;

\echo '--- BEFORE → AFTER preview ---'
SELECT b.id,
       (b.fare_breakdown->>'delivery_charge')::numeric AS taxable,
       (b.fare_breakdown->>'gst_percent')::numeric     AS gst_pct,
       (b.fare_breakdown->>'cgst_amount')              AS old_cgst,
       (b.fare_breakdown->>'sgst_amount')              AS old_sgst,
       (b.fare_breakdown->>'gst_amount')               AS old_gst,
       round((b.fare_breakdown->>'delivery_charge')::numeric
             * (b.fare_breakdown->>'gst_percent')::numeric / 2 / 100, 2) AS new_cgst_sgst_each
  FROM bookings b
 WHERE (b.fare_breakdown->>'gst_amount')::numeric > 0;

-- Recompute CGST and SGST independently (each = taxable × gst%/2, 2 decimals),
-- gst_amount = CGST + SGST, and re-foot total_payable / estimated_fare.
UPDATE bookings b
SET fare_breakdown = b.fare_breakdown || jsonb_build_object(
      'cgst_amount',      round(s.tx * s.gp / 2 / 100, 2),
      'sgst_amount',      round(s.tx * s.gp / 2 / 100, 2),
      'gst_amount',       round(s.tx * s.gp / 2 / 100, 2) * 2,
      'platform_fee_gst', round(s.tx * s.gp / 2 / 100, 2) * 2,
      'platform_fee',     s.pf,
      'total_payable',    s.tx + round(s.tx * s.gp / 2 / 100, 2) * 2 + s.pf
    ),
    estimated_fare = s.tx + round(s.tx * s.gp / 2 / 100, 2) * 2 + s.pf
FROM (
  SELECT id,
         (fare_breakdown->>'delivery_charge')::numeric AS tx,
         (fare_breakdown->>'gst_percent')::numeric     AS gp,
         -- Customer-facing platform fee from config (existing rows may have had
         -- it overwritten with the ₹2 internal driver cut on completion).
         COALESCE((SELECT value::numeric FROM system_settings WHERE key = 'platform_fee' LIMIT 1), 5) AS pf
    FROM bookings
   WHERE (fare_breakdown->>'gst_amount')::numeric > 0
) s
WHERE b.id = s.id;

-- Keep the completed payment amount in sync with the re-footed total.
UPDATE payments p
SET amount = b.estimated_fare
FROM bookings b
WHERE p.booking_id = b.id
  AND (b.fare_breakdown->>'gst_amount')::numeric > 0;

\echo '--- AFTER ---'
SELECT b.id,
       b.fare_breakdown->>'delivery_charge' AS taxable,
       b.fare_breakdown->>'platform_fee'  AS platform_fee,
       b.fare_breakdown->>'cgst_amount'  AS cgst,
       b.fare_breakdown->>'sgst_amount'  AS sgst,
       b.fare_breakdown->>'gst_amount'   AS gst,
       b.fare_breakdown->>'total_payable' AS total_payable,
       b.estimated_fare
  FROM bookings b
 WHERE (b.fare_breakdown->>'gst_amount')::numeric > 0;

-- Change to ROLLBACK; for a dry run.
COMMIT;
