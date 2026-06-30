import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

export interface CashfreeTransferResult {
  /** Our transfer_id (== withdrawal-derived id). */
  transferId: string;
  /** Cashfree's internal transfer id. */
  cfTransferId?: string | null;
  /** RECEIVED | APPROVAL_PENDING | PENDING | SUCCESS | FAILED | REJECTED | REVERSED */
  status: string;
  utr?: string | null;
  message?: string | null;
}

/**
 * Cashfree Payouts (V2, x-api-version 2024-01-01).
 *
 * Used for automated driver wallet withdrawals (and admin-initiated Zipto Shield
 * withdrawals). Flow:
 *   1. createBeneficiary() — register the driver's bank account once.
 *   2. createTransfer()    — push money to that beneficiary (IMPS).
 *   3. Cashfree calls our payout webhook (TRANSFER_SUCCESS / TRANSFER_FAILED /
 *      TRANSFER_REVERSED) which finalizes the withdrawal or refunds the wallet.
 *
 * Payouts use SEPARATE credentials from the Payment Gateway — set
 * CASHFREE_PAYOUT_CLIENT_ID / CASHFREE_PAYOUT_CLIENT_SECRET in .env.
 */
@Injectable()
export class CashfreePayoutService {
  private readonly logger = new Logger(CashfreePayoutService.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  /** Dedicated payout webhook signing secret; falls back to clientSecret. */
  private readonly webhookSecret: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  readonly mode: 'production' | 'sandbox';

  constructor(private readonly config: ConfigService) {
    this.clientId = (process.env.CASHFREE_PAYOUT_CLIENT_ID || '').trim();
    this.clientSecret = (process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '').trim();
    this.webhookSecret =
      (process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET || '').trim() || this.clientSecret;
    this.apiVersion = (process.env.CASHFREE_PAYOUT_API_VERSION || '2024-01-01').trim();
    this.mode =
      (process.env.CASHFREE_PAYOUT_ENV || process.env.CASHFREE_ENV || 'production').trim() ===
      'sandbox'
        ? 'sandbox'
        : 'production';
    this.baseUrl =
      this.mode === 'sandbox'
        ? 'https://sandbox.cashfree.com/payout'
        : 'https://api.cashfree.com/payout';

    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'Cashfree Payouts not configured — set CASHFREE_PAYOUT_CLIENT_ID and ' +
          'CASHFREE_PAYOUT_CLIENT_SECRET in .env to enable automated driver payouts.',
      );
    } else {
      this.logger.log(`Cashfree Payouts ready — mode=${this.mode}, apiVersion=${this.apiVersion}`);
    }
  }

  get isConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  private headers() {
    return {
      'X-Client-Id': this.clientId,
      'X-Client-Secret': this.clientSecret,
      'x-api-version': this.apiVersion,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Available Payouts balance (the prepaid pool that funds driver withdrawals).
   *
   * Payouts V2 has NO balance endpoint, so this uses the legacy V1
   * authorize → getBalance flow with the same credentials. If V1 isn't enabled
   * on the account it returns a null balance + reason (view it in the Cashfree
   * dashboard → Payouts → Balance instead). Never throws.
   */
  async getBalance(): Promise<{
    configured: boolean;
    mode: 'production' | 'sandbox';
    available_balance: number | null;
    balance: number | null;
    error?: string;
  }> {
    const base = { configured: this.isConfigured, mode: this.mode };
    if (!this.isConfigured) {
      return { ...base, available_balance: null, balance: null, error: 'Payouts not configured' };
    }
    const v1Base =
      this.mode === 'sandbox'
        ? 'https://payout-gamma.cashfree.com'
        : 'https://payout-api.cashfree.com';
    try {
      const auth = await axios.post(`${v1Base}/payout/v1/authorize`, {}, {
        headers: { 'X-Client-Id': this.clientId, 'X-Client-Secret': this.clientSecret },
        timeout: 12000,
      });
      const token = auth.data?.data?.token;
      if (!token) {
        return { ...base, available_balance: null, balance: null, error: 'Payouts V1 authorize returned no token' };
      }
      const res = await axios.get(`${v1Base}/payout/v1/getBalance`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12000,
      });
      const d = res.data?.data ?? {};
      return {
        ...base,
        available_balance: d.availableBalance != null ? Number(d.availableBalance) : null,
        balance: d.balance != null ? Number(d.balance) : null,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'unknown error';
      this.logger.warn(`[CashfreePayout] getBalance failed: ${msg}`);
      return { ...base, available_balance: null, balance: null, error: msg };
    }
  }

  /** Cashfree beneficiary/transfer ids: alphanumeric + _ only, ≤ 40 chars. */
  private sanitizeId(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
  }

  generateBeneficiaryId(driverProfileId: string): string {
    return this.sanitizeId(`zd_${driverProfileId.replace(/-/g, '')}`);
  }

  generateTransferId(withdrawalId: string): string {
    return this.sanitizeId(`wd_${withdrawalId.replace(/-/g, '')}`);
  }

  /**
   * Create (or upsert) a beneficiary for a driver's bank account.
   * Returns the beneficiary_id. If the beneficiary already exists Cashfree
   * returns 409 — we treat that as success and return the existing id.
   */
  async createBeneficiary(data: {
    beneficiaryId: string;
    name: string;
    phone: string;
    email?: string;
    ifsc: string;
    accountNumber: string;
  }): Promise<string> {
    const body = {
      beneficiary_id: data.beneficiaryId,
      beneficiary_name: data.name.slice(0, 100),
      beneficiary_instrument_details: {
        bank_account_number: data.accountNumber,
        bank_ifsc: data.ifsc.toUpperCase(),
      },
      beneficiary_contact_details: {
        beneficiary_phone: (data.phone || '').replace(/\D/g, '').slice(-10),
        ...(data.email ? { beneficiary_email: data.email } : {}),
        beneficiary_country_code: '+91',
      },
    };

    try {
      const { data: res } = await axios.post(`${this.baseUrl}/beneficiary`, body, {
        headers: this.headers(),
        timeout: 15000,
      });
      this.logger.log(`[CashfreePayout] Beneficiary created: ${res.beneficiary_id ?? data.beneficiaryId}`);
      return (res.beneficiary_id as string) ?? data.beneficiaryId;
    } catch (err: any) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code ?? err?.response?.data?.type;
      // Already exists → idempotent success
      if (status === 409 || code === 'beneficiary_already_exists') {
        this.logger.log(`[CashfreePayout] Beneficiary already exists: ${data.beneficiaryId}`);
        return data.beneficiaryId;
      }
      this.logger.error(
        `[CashfreePayout] createBeneficiary failed: ${JSON.stringify(err?.response?.data ?? err?.message)}`,
      );
      throw err;
    }
  }

  /** Fetch a beneficiary (null if not found). */
  async getBeneficiary(beneficiaryId: string): Promise<any | null> {
    try {
      const { data } = await axios.get(`${this.baseUrl}/beneficiary`, {
        headers: this.headers(),
        params: { beneficiary_id: beneficiaryId },
        timeout: 15000,
      });
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Initiate a standard (IMPS) transfer to a beneficiary.
   * @returns the transfer result (status drives our withdrawal state machine).
   */
  async createTransfer(data: {
    transferId: string;
    beneficiaryId: string;
    amount: number;
    remarks?: string;
    mode?: 'imps' | 'neft' | 'rtgs' | 'banktransfer';
  }): Promise<CashfreeTransferResult> {
    if (!this.isConfigured) {
      throw new Error('Cashfree Payouts not configured');
    }
    const body = {
      transfer_id: data.transferId,
      transfer_amount: Number(data.amount.toFixed(2)),
      transfer_mode: data.mode ?? 'imps',
      beneficiary_details: {
        beneficiary_id: data.beneficiaryId,
      },
      ...(data.remarks ? { transfer_remarks: data.remarks.slice(0, 70) } : {}),
    };

    const { data: res } = await axios.post(`${this.baseUrl}/transfers`, body, {
      headers: this.headers(),
      timeout: 20000,
    });

    this.logger.log(
      `[CashfreePayout] Transfer initiated: transfer_id=${res.transfer_id}, status=${res.status}`,
    );
    return {
      transferId: res.transfer_id ?? data.transferId,
      cfTransferId: res.cf_transfer_id ?? null,
      status: res.status ?? 'PENDING',
      utr: res.transfer_utr ?? null,
      message: res.status_description ?? res.message ?? null,
    };
  }

  /** Fetch a transfer's current status (authoritative reconciliation). */
  async getTransfer(transferId: string): Promise<CashfreeTransferResult | null> {
    try {
      const { data } = await axios.get(`${this.baseUrl}/transfers`, {
        headers: this.headers(),
        params: { transfer_id: transferId },
        timeout: 15000,
      });
      return {
        transferId: data.transfer_id ?? transferId,
        cfTransferId: data.cf_transfer_id ?? null,
        status: data.status ?? 'PENDING',
        utr: data.transfer_utr ?? null,
        message: data.status_description ?? null,
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Verify a Cashfree Payouts webhook signature.
   * Signature = base64( HMAC-SHA256( timestamp + rawBody, webhookSecret ) ).
   */
  verifyWebhookSignature(rawBody: string, signature: string, timestamp: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn('[CashfreePayout] No webhook secret set — skipping signature validation');
      return true;
    }
    if (!signature || !timestamp) return false;
    try {
      const payload = `${timestamp}${rawBody}`;
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (err: any) {
      this.logger.warn(`[CashfreePayout] webhook signature verify failed: ${err?.message}`);
      return false;
    }
  }
}
