import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto');

export interface RazorpayXPayout {
  id: string;
  status: 'queued' | 'pending' | 'rejected' | 'processing' | 'processed' | 'cancelled' | 'reversed' | string;
  utr?: string;
  failure_reason?: string;
}

@Injectable()
export class RazorpayXService {
  private readonly logger = new Logger(RazorpayXService.name);

  constructor(private readonly configService: ConfigService) {}

  private getRazorpay(): any {
    const keyId     = this.configService.get<string>('externalServices.razorpay.keyId')     ?? '';
    const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') ?? '';
    if (!keyId || !keySecret) throw new Error('Razorpay API credentials not configured');
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  private get accountNumber(): string {
    return this.configService.get<string>('externalServices.razorpayx.accountNumber') ?? '';
  }

  get isConfigured(): boolean {
    const keyId  = this.configService.get<string>('externalServices.razorpay.keyId') ?? '';
    return !!this.accountNumber && !!keyId && !keyId.startsWith('rzp_test');
  }

  /**
   * Create a RazorpayX Contact for a driver.
   * Contacts are reused — if the reference_id already exists Razorpay returns an error;
   * we retry with a unique suffix so the account is always created.
   */
  async createContact(data: {
    name: string;
    email?: string;
    phone: string;
    referenceId: string;
  }): Promise<string> {
    const rz = this.getRazorpay();
    const payload = {
      name: data.name,
      email: data.email || undefined,
      contact: data.phone,
      type: 'employee',
      reference_id: data.referenceId.slice(0, 40),
    };
    try {
      const contact = await rz.contacts.create(payload);
      this.logger.log(`[RazorpayX] Contact created: ${contact.id}`);
      return contact.id as string;
    } catch (err: any) {
      // reference_id collision — retry with timestamp suffix
      if (err?.error?.code === 'BAD_REQUEST_ERROR') {
        const retryPayload = {
          ...payload,
          reference_id: `${data.referenceId.slice(0, 28)}_${Date.now().toString().slice(-8)}`,
        };
        const contact = await rz.contacts.create(retryPayload);
        this.logger.log(`[RazorpayX] Contact created (retry): ${contact.id}`);
        return contact.id as string;
      }
      this.logger.error(`[RazorpayX] createContact failed: ${JSON.stringify(err?.error ?? err)}`);
      throw err;
    }
  }

  /**
   * Create a RazorpayX Fund Account (bank account) linked to a contact.
   */
  async createFundAccount(data: {
    contactId: string;
    accountHolderName: string;
    ifscCode: string;
    accountNumber: string;
  }): Promise<string> {
    const rz = this.getRazorpay();
    const fundAccount = await rz.fundAccount.create({
      contact_id: data.contactId,
      account_type: 'bank_account',
      bank_account: {
        name: data.accountHolderName,
        ifsc: data.ifscCode,
        account_number: data.accountNumber,
      },
    });
    this.logger.log(`[RazorpayX] Fund account created: ${fundAccount.id}`);
    return fundAccount.id as string;
  }

  /**
   * Initiate a payout to a driver's fund account.
   * queue_if_low_balance=true ensures payouts are queued rather than failing
   * if the RazorpayX account balance is temporarily insufficient.
   *
   * @returns Razorpay payout object (id + status)
   */
  async createPayout(data: {
    fundAccountId: string;
    amountPaise: number;
    referenceId: string;
    narration: string;
    mode?: 'IMPS' | 'NEFT' | 'RTGS';
  }): Promise<RazorpayXPayout> {
    if (!this.accountNumber) {
      throw new Error(
        'RAZORPAYX_ACCOUNT_NUMBER not configured — add it to .env to enable automated payouts.',
      );
    }
    const rz = this.getRazorpay();
    const payout = await rz.payouts.create({
      account_number: this.accountNumber,
      fund_account_id: data.fundAccountId,
      amount: data.amountPaise,
      currency: 'INR',
      mode: data.mode ?? 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: data.referenceId.slice(0, 40),
      narration: data.narration.slice(0, 30),
    });
    this.logger.log(`[RazorpayX] Payout initiated: id=${payout.id}, status=${payout.status}`);
    return { id: payout.id, status: payout.status, utr: payout.utr, failure_reason: payout.failure_reason };
  }

  /**
   * Verify the RazorpayX payout webhook signature.
   * Set RAZORPAYX_WEBHOOK_SECRET in your Razorpay dashboard → Settings → Webhooks.
   */
  validateWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = this.configService.get<string>('externalServices.razorpayx.webhookSecret') ?? '';
    if (!secret) {
      this.logger.warn('[RazorpayX] RAZORPAYX_WEBHOOK_SECRET not set — skipping signature validation');
      return true;
    }
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return expected === signature;
  }
}
