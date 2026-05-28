import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type HdfcOrderStatus = 'Success' | 'Failure' | 'Aborted' | 'Invalid';

export interface HdfcInitiateParams {
  orderId: string;
  amount: number;
  billingName?: string;
  billingEmail?: string;
  billingPhone?: string;
  merchantRef: string; // stored in merchant_param1 (e.g. "BOOKING:uuid" or "WALLET:userId")
}

export interface HdfcPaymentResult {
  orderId: string;
  trackingId: string;
  bankRefNo: string;
  orderStatus: HdfcOrderStatus;
  failureMessage: string;
  paymentMode: string;
  amount: string;
  statusCode: string;
  statusMessage: string;
  merchantRef: string;
}

@Injectable()
export class HdfcPaymentService {
  private readonly logger = new Logger(HdfcPaymentService.name);

  private readonly merchantId: string;
  private readonly accessCode: string;
  private readonly workingKey: string;
  private readonly paymentUrl: string;
  private readonly redirectBase: string;

  constructor(private readonly config: ConfigService) {
    this.merchantId = this.config.get<string>('HDFC_MERCHANT_ID') ?? '';
    this.accessCode = this.config.get<string>('HDFC_ACCESS_CODE') ?? '';
    this.workingKey = this.config.get<string>('HDFC_WORKING_KEY') ?? '';
    this.redirectBase =
      this.config.get<string>('HDFC_REDIRECT_BASE_URL') ?? 'https://api.ridezipto.com/api';

    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    this.paymentUrl = isProduction
      ? 'https://smartgateway.hdfcbank.com/servlet/payment_handler'
      : 'https://smartgatewayuat.hdfcbank.com/servlet/payment_handler';

    if (!this.merchantId || !this.accessCode || !this.workingKey) {
      this.logger.warn(
        'HDFC credentials not set — set HDFC_MERCHANT_ID, HDFC_ACCESS_CODE, HDFC_WORKING_KEY in .env',
      );
    } else {
      this.logger.log('HDFC Payment Service initialized');
    }
  }

  get isEnabled(): boolean {
    return !!(this.merchantId && this.accessCode && this.workingKey);
  }

  get frontendAccessCode(): string {
    return this.accessCode;
  }

  get frontendPaymentUrl(): string {
    return this.paymentUrl;
  }

  /** AES-128-CBC encrypt using MD5(workingKey) as the key, zero IV */
  private encrypt(plainText: string): string {
    const key = crypto.createHash('md5').update(this.workingKey).digest();
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return cipher.update(plainText, 'utf8', 'hex') + cipher.final('hex');
  }

  /** AES-128-CBC decrypt */
  private decrypt(cipherHex: string): string {
    const key = crypto.createHash('md5').update(this.workingKey).digest();
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return decipher.update(cipherHex, 'hex', 'utf8') + decipher.final('utf8');
  }

  /** Generate a unique order ID: ZP + 13-digit timestamp (22 chars max) */
  generateOrderId(): string {
    return `ZP${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  }

  /**
   * Build the encrypted request to pass to HDFC.
   * Returns { encRequest, accessCode, paymentUrl } — the frontend submits
   * a form POST to paymentUrl with these two fields.
   */
  buildRequest(params: HdfcInitiateParams): {
    encRequest: string;
    accessCode: string;
    paymentUrl: string;
  } {
    const redirectUrl = `${this.redirectBase}/payment/hdfc/response`;
    const cancelUrl = `${this.redirectBase}/payment/hdfc/result?status=cancelled&orderId=${params.orderId}`;

    const pairs = [
      `merchant_id=${this.merchantId}`,
      `order_id=${params.orderId}`,
      `amount=${params.amount.toFixed(2)}`,
      `currency=INR`,
      `redirect_url=${redirectUrl}`,
      `cancel_url=${cancelUrl}`,
      `language=EN`,
      params.billingName ? `billing_name=${params.billingName}` : '',
      params.billingEmail ? `billing_email=${params.billingEmail}` : '',
      params.billingPhone ? `billing_tel=${params.billingPhone}` : '',
      `billing_country=India`,
      `merchant_param1=${params.merchantRef}`,
    ]
      .filter(Boolean)
      .join('&');

    return {
      encRequest: this.encrypt(pairs),
      accessCode: this.accessCode,
      paymentUrl: this.paymentUrl,
    };
  }

  /**
   * Parse and decrypt the encResp that HDFC POSTs to our redirect_url.
   */
  parseResponse(encResp: string): HdfcPaymentResult {
    let decrypted: string;
    try {
      decrypted = this.decrypt(encResp);
    } catch (err) {
      this.logger.error(`HDFC decrypt failed: ${(err as Error).message}`);
      return {
        orderId: '',
        trackingId: '',
        bankRefNo: '',
        orderStatus: 'Invalid',
        failureMessage: 'Decryption failed',
        paymentMode: '',
        amount: '',
        statusCode: '-1',
        statusMessage: 'Decryption failed',
        merchantRef: '',
      };
    }

    const parsed: Record<string, string> = {};
    decrypted.split('&').forEach(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        parsed[pair.substring(0, eqIdx)] = decodeURIComponent(
          pair.substring(eqIdx + 1).replace(/\+/g, ' '),
        );
      }
    });

    return {
      orderId: parsed.order_id ?? '',
      trackingId: parsed.tracking_id ?? '',
      bankRefNo: parsed.bank_ref_no ?? '',
      orderStatus: (parsed.order_status as HdfcOrderStatus) ?? 'Invalid',
      failureMessage: parsed.failure_message ?? '',
      paymentMode: parsed.payment_mode ?? '',
      amount: parsed.amount ?? '',
      statusCode: parsed.status_code ?? '',
      statusMessage: parsed.status_message ?? '',
      merchantRef: parsed.merchant_param1 ?? '',
    };
  }
}
