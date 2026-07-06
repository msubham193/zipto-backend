import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from './entities/system-setting.entity';

export interface DispatchSettings {
  search_radius_km: number;
  broadcast_radius_km: number;
  offer_timeout_seconds: number;
  max_search_attempts: number;
}

const DEFAULTS: Array<{ key: string; value: string; description: string }> = [
  { key: 'search_radius_km',       value: '4',  description: 'Radius in km for sequential driver search (nearest driver first)' },
  { key: 'broadcast_radius_km',    value: '10', description: 'Radius in km for broadcast after sequential search is exhausted' },
  { key: 'offer_timeout_seconds',  value: '15', description: 'Seconds each driver has to accept or reject an offer' },
  { key: 'max_search_attempts',    value: '10', description: 'Max sequential attempts before falling back to broadcast' },
  { key: 'zipto_upi_id',           value: 'zipto@upi', description: 'Zipto UPI ID shown to drivers for wallet top-up payments' },
  { key: 'zipto_upi_name',         value: 'Zipto',     description: 'Display name shown in UPI apps during top-up' },
  { key: 'referral_enabled',        value: 'true', description: 'Master switch for the referral program' },
  { key: 'referral_referee_coins',  value: '500',  description: 'Coins credited to the new user (referee) after their first completed ride' },
  { key: 'referral_referrer_coins', value: '1000', description: 'Coins credited to the referrer after their referee completes a first ride' },
  { key: 'referral_share_base_url', value: 'https://refer.bookfleet.in/refer', description: 'Base URL for referral share links (code is appended: /refer/CODE)' },
  { key: 'referral_banner_url',     value: 'https://refer.bookfleet.in/referral-banner.jpeg', description: 'Banner image shown as the WhatsApp/social link preview (og:image)' },
  { key: 'referral_play_store_url', value: 'https://play.google.com/store/apps/details?id=com.ridezipto.customer', description: 'Play Store URL the referral landing page redirects to' },
  { key: 'platform_fee', value: '5', description: 'Flat platform fee (₹) added to every fare. Admin-configurable; shown on the customer fare estimate.' },
  { key: 'gst_percent',  value: '0', description: 'GST percentage applied on the delivery charge. Admin-configurable; shown on the customer fare estimate.' },
  { key: 'zipto_gstin',        value: '', description: 'Zipto\'s own GSTIN, printed on B2B tax invoices.' },
  { key: 'zipto_legal_name',   value: 'Zipto Hyperlogistics Pvt. Ltd.', description: 'Legal entity name printed on tax invoices.' },
  { key: 'zipto_gst_state',    value: 'Odisha', description: 'Zipto place-of-supply state (drives CGST+SGST vs IGST on invoices).' },
  { key: 'zipto_invoice_address', value: '781, Saheed Nagar, Maharishi College Road, Bhubaneswar, Odisha 751007', description: 'Registered address printed on tax invoices.' },
];

export interface FareSettings {
  platform_fee: number;
  gst_percent: number;
}

export interface TaxSettings {
  zipto_gstin: string;
  zipto_legal_name: string;
  zipto_gst_state: string;
  zipto_invoice_address: string;
}

export interface ReferralSettings {
  enabled: boolean;
  referee_coins: number;
  referrer_coins: number;
  share_base_url: string;
  banner_url: string;
  play_store_url: string;
}

const CACHE_TTL_MS = 30_000; // re-read DB at most every 30 s

@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);
  private cache: DispatchSettings | null = null;
  private cacheAt = 0;
  private fareCache: FareSettings | null = null;
  private fareCacheAt = 0;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly repo: Repository<SystemSetting>,
  ) {}

  /** Seed missing rows on startup so the table is always complete. */
  async onModuleInit() {
    try {
      for (const row of DEFAULTS) {
        const exists = await this.repo.findOne({ where: { key: row.key } });
        if (!exists) {
          await this.repo.save(this.repo.create(row));
        }
      }
      this.logger.log('System settings seeded');
    } catch (err) {
      this.logger.error('Failed to seed system settings', err);
    }
  }

  /** Reads all dispatch settings from DB with a 30-second in-memory cache. */
  async getDispatchSettings(): Promise<DispatchSettings> {
    if (this.cache && Date.now() - this.cacheAt < CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const rows = await this.repo.find();
      const map: Record<string, string> = {};
      for (const r of rows) { map[r.key] = r.value; }

      this.cache = {
        search_radius_km:      parseFloat(map.search_radius_km      ?? '4'),
        broadcast_radius_km:   parseFloat(map.broadcast_radius_km   ?? '10'),
        offer_timeout_seconds: parseInt(map.offer_timeout_seconds   ?? '15', 10),
        max_search_attempts:   parseInt(map.max_search_attempts     ?? '10', 10),
      };
      this.cacheAt = Date.now();
    } catch (err) {
      this.logger.error('Failed to read system settings, using defaults', err);
      // Fall back to hardcoded defaults so booking flow never breaks
      this.cache = { search_radius_km: 4, broadcast_radius_km: 10, offer_timeout_seconds: 15, max_search_attempts: 10 };
    }
    return this.cache!;
  }

  /**
   * Platform fee + GST settings (admin-configurable), 30-second cached.
   * GST is applied on the platform fee and shown on the customer fare estimate.
   */
  async getFareSettings(): Promise<FareSettings> {
    if (this.fareCache && Date.now() - this.fareCacheAt < CACHE_TTL_MS) {
      return this.fareCache;
    }
    try {
      const rows = await this.repo.find({ where: [{ key: 'platform_fee' }, { key: 'gst_percent' }] });
      const map: Record<string, string> = {};
      for (const r of rows) { map[r.key] = r.value; }
      this.fareCache = {
        // Platform fee has a HARD FLOOR of ₹5 — it can be raised but never set
        // below 5 (or 0). A stored 0/invalid value falls back to the ₹5 minimum.
        platform_fee: Math.max(5, parseFloat(map.platform_fee ?? '5') || 5),
        gst_percent:  Math.max(0, parseFloat(map.gst_percent ?? '0') || 0),
      };
      this.fareCacheAt = Date.now();
    } catch (err) {
      this.logger.error('Failed to read fare settings, using defaults', err);
      this.fareCache = { platform_fee: 5, gst_percent: 0 };
    }
    return this.fareCache!;
  }

  /** Zipto's GST identity for B2B tax invoices (admin-configurable). */
  async getTaxSettings(): Promise<TaxSettings> {
    const rows = await this.repo.find({
      where: [
        { key: 'zipto_gstin' },
        { key: 'zipto_legal_name' },
        { key: 'zipto_gst_state' },
        { key: 'zipto_invoice_address' },
      ],
    });
    const map: Record<string, string> = {};
    for (const r of rows) { map[r.key] = r.value; }
    return {
      zipto_gstin: map.zipto_gstin ?? '',
      zipto_legal_name: map.zipto_legal_name ?? 'Zipto Hyperlogistics Pvt. Ltd.',
      zipto_gst_state: map.zipto_gst_state ?? 'Odisha',
      zipto_invoice_address: map.zipto_invoice_address ?? '',
    };
  }

  /** Referral program settings (admin-configurable). Falls back to defaults. */
  async getReferralSettings(): Promise<ReferralSettings> {
    const rows = await this.repo.find({
      where: [
        { key: 'referral_enabled' },
        { key: 'referral_referee_coins' },
        { key: 'referral_referrer_coins' },
        { key: 'referral_share_base_url' },
        { key: 'referral_banner_url' },
        { key: 'referral_play_store_url' },
      ],
    });
    const map: Record<string, string> = {};
    for (const r of rows) { map[r.key] = r.value; }
    return {
      enabled: (map.referral_enabled ?? 'true') !== 'false',
      referee_coins: parseInt(map.referral_referee_coins ?? '500', 10) || 0,
      referrer_coins: parseInt(map.referral_referrer_coins ?? '1000', 10) || 0,
      share_base_url: (map.referral_share_base_url ?? 'https://refer.bookfleet.in/refer').replace(/\/+$/, ''),
      banner_url: map.referral_banner_url ?? 'https://refer.bookfleet.in/referral-banner.jpeg',
      play_store_url: map.referral_play_store_url ?? 'https://play.google.com/store/apps/details?id=com.ridezipto.customer',
    };
  }

  /** Returns UPI ID and display name for driver wallet top-up. */
  async getUpiInfo(): Promise<{ upi_id: string; name: string }> {
    const rows = await this.repo.find({ where: [{ key: 'zipto_upi_id' }, { key: 'zipto_upi_name' }] });
    const map: Record<string, string> = {};
    for (const r of rows) { map[r.key] = r.value; }
    return {
      upi_id: map.zipto_upi_id ?? 'zipto@upi',
      name:   map.zipto_upi_name ?? 'Zipto',
    };
  }

  /** Get all settings as raw rows (for admin list view). */
  async getAll(): Promise<SystemSetting[]> {
    return this.repo.find();
  }

  /** Update a single setting and invalidate cache. */
  async update(key: string, value: string): Promise<SystemSetting> {
    const setting = await this.repo.findOne({ where: { key } });
    if (!setting) {
      // Allow creating unknown keys so future settings can be added live
      const created = this.repo.create({ key, value });
      const saved = await this.repo.save(created);
      this.cache = null; this.fareCache = null; // invalidate
      return saved;
    }
    setting.value = String(value);
    const saved = await this.repo.save(setting);
    this.cache = null; this.fareCache = null; // invalidate
    return saved;
  }
}
