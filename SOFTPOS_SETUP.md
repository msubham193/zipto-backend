# Cashfree SoftPOS (Dynamic UPI QR) — Setup

Replaces the at-delivery hosted-checkout link with a **dynamic UPI QR** minted
via Cashfree's Terminal (SoftPOS, agent collection) APIs. Scanning it opens the
customer's UPI app **directly** — no hosted checkout, no "redirecting to an
external website" warning. Payment is still tracked by the normal Cashfree
webhook, so auto-confirmation is unchanged.

## Architecture (per-rider terminal → per-order QR)

```
Driver approved / first collection
   └─ DriverService.ensureDriverTerminal()  → POST /terminal (once)  → cf_terminal_id (stored on driver_profiles)
Rider taps "collect online" after ride
   └─ PaymentService.createBookingPaymentLink()
        ├─ POST /orders                       → cf_order_id
        ├─ POST /terminal/transactions        → qrcode (base64 PNG)  [payment_method=QR_CODE]
        └─ returns data:image/png;base64,...  → rider app shows it as an <Image>
Customer scans → pays in their UPI app → Cashfree webhook → payment marked COMPLETED
```

- Terminal creation is **lazy + idempotent** (`terminal_id = rider_<profileId>`), so
  drivers approved before this feature get a terminal on first use.
- Everything is **gated by a feature flag** and **falls back** to the existing
  UPI-QR → payment-link flow if SoftPOS is off, the terminal can't be created, or
  the QR isn't returned. The working flow is never broken.

## Enable it (production)

1. **Confirm with Cashfree** that the SoftPOS / Terminal product is **activated**
   on your live account (the `/terminal` + `/terminal/transactions` endpoints
   under `x-api-version: 2025-01-01`). Without activation these calls error and
   the code auto-falls back.
2. Run the migration (adds `driver_profiles.cf_terminal_id`):
   ```sql
   \i migration_production.sql   -- idempotent; section 8 adds the column
   ```
3. Set env and restart:
   ```env
   CASHFREE_SOFTPOS_ENABLED=true
   CASHFREE_SOFTPOS_API_VERSION=2025-01-01   # optional; this is the default
   ```
4. Deploy. No app rebuild needed — the rider app already renders a base64 QR
   (it detects the `data:image` URI and shows it directly).

## Verify
- Approve/collect for a driver → logs `[softpos] terminal created … cf_terminal_id=…`.
- Complete a ride, tap collect → logs `[softpos] qr minted order=… ₹…`; the rider
  screen shows a QR that opens GPay/PhonePe directly (no web page).
- Pay → existing webhook marks it COMPLETED and auto-confirms on the rider screen.

## Rollback
Set `CASHFREE_SOFTPOS_ENABLED=false` (or unset) and restart — instantly reverts
to the previous UPI-QR / payment-link behaviour. No data migration needed.
