# Public static assets

Files here are served at the host **root** (no `/api` prefix), e.g.:

```
skido-backend/public/referral-banner.png  →  https://api.ridezipto.com/referral-banner.png
```

## Referral banner (`referral-banner.png`)

This image is used as the OpenGraph `og:image` for referral link previews on
WhatsApp / Telegram / social, and is shown on the `/refer/:code` landing page.

**Requirements (important):**
- Filename: `referral-banner.png` (or update the `referral_banner_url` setting).
- Resize to ~**1200×675** (16:9) and keep it **under 300 KB** — WhatsApp skips
  preview images that are too large.

## Deploy note

`useStaticAssets()` reads this folder relative to the build output
(`dist/../public`), so the `public/` directory must exist next to `dist/` on the
server. If your deploy copies only `dist/`, also copy `public/` (or commit the
banner so it ships with the repo checkout).
