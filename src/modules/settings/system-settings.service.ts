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
  { key: 'referral_share_base_url', value: 'https://api.ridezipto.com/refer', description: 'Base URL for referral share links (code is appended: /refer/CODE)' },
  { key: 'referral_banner_url',     value: 'https://api.ridezipto.com/referral-banner.png', description: 'Banner image shown as the WhatsApp/social link preview (og:image)' },
  { key: 'referral_play_store_url', value: 'https://play.google.com/store/apps/details?id=com.ridezipto.customer', description: 'Play Store URL the referral landing page redirects to' },
];

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
      share_base_url: (map.referral_share_base_url ?? 'https://api.ridezipto.com/refer').replace(/\/+$/, ''),
      banner_url: map.referral_banner_url ?? 'https://api.ridezipto.com/referral-banner.png',
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
      this.cache = null; // invalidate
      return saved;
    }
    setting.value = String(value);
    const saved = await this.repo.save(setting);
    this.cache = null; // invalidate
    return saved;
  }
}
