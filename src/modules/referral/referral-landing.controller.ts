import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SystemSettingsService } from '../settings/system-settings.service';

/**
 * Public, prefix-less landing page for referral share links
 * (https://api.ridezipto.com/refer/CODE).
 *
 * Its job is twofold:
 *  1. Serve OpenGraph/Twitter meta tags so WhatsApp/Telegram/social render the
 *     referral banner as a rich link preview when the link is shared.
 *  2. Deep-link openers into the app (zipto://refer?code=CODE), falling back to
 *     the Play Store, while stashing the code so signup can pre-fill it.
 */
@ApiExcludeController()
@Controller()
export class ReferralLandingController {
  constructor(private readonly settings: SystemSettingsService) {}

  @Public()
  @Get('refer/:code')
  async landing(@Param('code') rawCode: string, @Res() res: Response) {
    const code = (rawCode || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase();
    const cfg = await this.settings.getReferralSettings();

    const title = `Get ${cfg.referee_coins} Zipto coins`;
    const description =
      `Join Zipto with code ${code} and earn ${cfg.referee_coins} bonus coins on your first order. ` +
      `Fast, affordable last-mile delivery.`;
    const pageUrl = `${cfg.share_base_url}/${code}`;
    const appLink = `zipto://refer?code=${code}`;
    const storeUrl = cfg.play_store_url;
    const banner = cfg.banner_url;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(html({ code, title, description, pageUrl, appLink, storeUrl, banner }));
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function html(p: {
  code: string;
  title: string;
  description: string;
  pageUrl: string;
  appLink: string;
  storeUrl: string;
  banner: string;
}): string {
  const title = esc(p.title);
  const description = esc(p.description);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="${description}" />

  <!-- OpenGraph (WhatsApp / Facebook / Telegram) -->
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${esc(p.banner)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="675" />
  <meta property="og:url" content="${esc(p.pageUrl)}" />
  <meta property="og:site_name" content="Zipto" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${esc(p.banner)}" />

  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1E3AED;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{max-width:420px;width:100%;text-align:center}
    .banner{width:100%;border-radius:18px;margin-bottom:22px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
    h1{font-size:26px;font-weight:800;margin-bottom:8px}
    p{font-size:15px;color:#DBEAFE;margin-bottom:6px;line-height:1.5}
    .code{display:inline-block;font-weight:800;letter-spacing:3px;background:rgba(255,255,255,.14);border:1.5px dashed rgba(255,255,255,.5);border-radius:12px;padding:10px 18px;margin:14px 0;font-size:20px}
    .btn{display:block;width:100%;background:#FACC15;color:#1E3AED;font-weight:800;font-size:16px;text-decoration:none;padding:15px;border-radius:14px;margin-top:14px}
    .btn.secondary{background:transparent;color:#DBEAFE;font-weight:600;font-size:14px;margin-top:10px}
  </style>
</head>
<body>
  <div class="card">
    <img class="banner" src="${esc(p.banner)}" alt="Zipto referral" />
    <h1>${title}</h1>
    <p>${description}</p>
    <div class="code">${esc(p.code)}</div>
    <a class="btn" id="open" href="${esc(p.appLink)}">Open in Zipto app</a>
    <a class="btn secondary" href="${esc(p.storeUrl)}">Don't have the app? Download</a>
  </div>
  <script>
    // Try to open the app; fall back to the store if it isn't installed.
    (function () {
      var code = ${JSON.stringify(p.code)};
      try { localStorage.setItem('zipto_referral_code', code); } catch (e) {}
      var appLink = ${JSON.stringify(p.appLink)};
      var store = ${JSON.stringify(p.storeUrl)};
      var t = setTimeout(function () { window.location.href = store; }, 1600);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = appLink;
    })();
  </script>
</body>
</html>`;
}
