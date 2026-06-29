# OTP Auto-Fetch — Setup & Remaining Steps

Auto-fetch is implemented in **3 layers** across the customer and rider apps.
The first two work **right now** with no further setup; the third (true
hands-free auto-read) needs a one-time DLT + env step described below.

| Layer | Platform | Works now? | Needs |
|-------|----------|-----------|-------|
| 1. OS autofill (`oneTimeCode` / `sms-otp`) | iOS auto-fills from Messages; Android shows the code as a keyboard suggestion | ✅ Yes | nothing |
| 2. Clipboard auto-fill | both | ✅ Yes | nothing |
| 3. SMS Retriever (fully hands-free, zero taps) | Android | ⛔ Needs DLT + env | steps below |

After `npm install`, **rebuild both apps** so the native `react-native-otp-verify`
module is linked. Until step 3 below is done, layer 3 is a safe no-op and the
apps fall back to layers 1–2.

---

## Enabling hands-free SMS Retriever (layer 3)

SMS Retriever auto-reads the OTP SMS **only if** the SMS:
1. ends with the app's **11-character signing hash**, and
2. is **≤ 140 bytes** total.

The backend already sends a short, compliant message when configured:

```
Your Bookfleet OTP is 482913. Valid for 5 minutes. Do not share. FA+9qCX9VSu
```

### Step 1 — Get each app's RELEASE hash

The hash is derived from the **signing certificate**, so it differs per app and
per signing key. The apps log it on the OTP screen via `logOtpHash()`:

```bash
# Install the RELEASE build on a device, open the OTP screen, then:
adb logcat | grep -i "SMS Retriever app hash"
```

Do this for **both** the rider and customer release builds → two hashes.

> ⚠️ **Google Play App Signing:** if Play re-signs your app, the production hash
> comes from the **Play signing key**, not your upload key. Get it by installing
> the app from an internal-testing track and reading the logged hash, or compute
> it from the Play-managed certificate's SHA-256 in Play Console.

### Step 2 — Register ONE DLT template (serves both apps)

Register a single TRANS_SMS template on your DLT portal where the OTP, the
minutes, and the **hash** are variables (so the same template matches both
apps' different hashes):

```
Your Bookfleet OTP is {#var#}. Valid for {#var#} minutes. Do not share. {#var#}
```

Note the registered **CT_ID** (content template id). Header/sender stays `Zipto`
(your existing DLT sender) unless you register a new one.

### Step 3 — Set backend env vars and restart

```env
SMS_OTP_HASH_DRIVER=<rider release hash from step 1>
SMS_OTP_HASH_CUSTOMER=<customer release hash from step 1>
TWO_FACTOR_OTP_HASH_CT_ID=<CT_ID from step 2>
```

That's it. `sendOTP(phone, role)` now:
- driver login/register → appends the rider hash,
- customer login → appends the customer hash,
- resend → uses the stored user's role,
- and uses the new CT_ID.

If any of these three env vars is missing, the backend automatically falls back
to the **existing** login template (no hash) — so nothing breaks before setup.

---

## Verifying

1. Install the **release** apps (debug hashes differ — auto-read won't work on
   debug unless you also register the debug hash).
2. Trigger a login OTP. The SMS arrives, and within ~1s the code fills and the
   screen auto-submits — no tap, no clipboard, no keyboard suggestion needed.
