import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

export interface CashfreeOrderResult {
  orderId: string;
  paymentSessionId: string;
}

export interface CashfreeOrderStatus {
  orderId: string;
  orderStatus: string; // ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED
  orderAmount: number;
  isPaid: boolean;
  customerId?: string;
  tags?: Record<string, string> | null;
}

/**
 * Cashfree Payment Gateway (Orders API, version 2023-08-01).
 *
 * Flow:
 *   1. createOrder() → returns a payment_session_id the client checkout uses.
 *   2. Customer pays via the hosted/JS checkout (opened in a WebView).
 *   3. Cashfree calls our webhook (authoritative) AND redirects to return_url.
 *   4. getOrder()/webhook → mark the booking paid.
 */
@Injectable()
export class CashfreeService {
  private readonly logger = new Logger(CashfreeService.name);

  private readonly appId: string;
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  /** 'production' | 'sandbox' — drives both the API host and the JS SDK mode. */
  readonly mode: 'production' | 'sandbox';

  constructor(private readonly config: ConfigService) {
    this.appId = (process.env.CASHFREE_APP_ID || '').trim();
    this.secretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();
    this.apiVersion = (process.env.CASHFREE_API_VERSION || '2023-08-01').trim();
    this.mode = (process.env.CASHFREE_ENV || 'production').trim() === 'sandbox'
      ? 'sandbox'
      : 'production';
    this.baseUrl = this.mode === 'sandbox'
      ? 'https://sandbox.cashfree.com/pg'
      : 'https://api.cashfree.com/pg';

    if (!this.appId || !this.secretKey) {
      this.logger.warn(
        'Cashfree credentials not set — set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env',
      );
    } else {
      this.logger.log(`Cashfree PG ready — mode=${this.mode}, apiVersion=${this.apiVersion}`);
    }
  }

  get isEnabled(): boolean {
    return !!this.appId && !!this.secretKey;
  }

  private headers() {
    return {
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey,
      'x-api-version': this.apiVersion,
      'Content-Type': 'application/json',
    };
  }

  /** A short, unique Cashfree order id (≤ 50 chars, alphanumeric + _-). */
  generateOrderId(): string {
    return `zipto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Create a Cashfree order and return the payment_session_id used by the
   * checkout. `notifyUrl` (webhook) and `returnUrl` should be public backend URLs.
   */
  async createOrder(params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerPhone: string;
    customerEmail?: string;
    returnUrl: string;
    notifyUrl: string;
    tags?: Record<string, string>;
  }): Promise<CashfreeOrderResult> {
    const body = {
      order_id: params.orderId,
      order_amount: Number(params.amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        customer_id: params.customerId,
        customer_phone: params.customerPhone,
        ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      },
      order_meta: {
        return_url: params.returnUrl,
        notify_url: params.notifyUrl,
      },
      ...(params.tags ? { order_tags: params.tags } : {}),
    };

    const { data } = await axios.post(`${this.baseUrl}/orders`, body, {
      headers: this.headers(),
      timeout: 15000,
    });

    return {
      orderId: data.order_id,
      paymentSessionId: data.payment_session_id,
    };
  }

  /** Fetch an order's current status (authoritative confirmation). */
  async getOrder(orderId: string): Promise<CashfreeOrderStatus> {
    const { data } = await axios.get(`${this.baseUrl}/orders/${orderId}`, {
      headers: this.headers(),
      timeout: 15000,
    });
    return {
      orderId: data.order_id,
      orderStatus: data.order_status,
      orderAmount: Number(data.order_amount) || 0,
      isPaid: data.order_status === 'PAID',
      customerId: data.customer_details?.customer_id,
      tags: data.order_tags ?? null,
    };
  }

  /**
   * Create a Cashfree Payment Link (used for the at-delivery QR the rider shows
   * the customer to pay online). Returns the shareable URL + a QR image if given.
   */
  async createPaymentLink(params: {
    linkId: string;
    amount: number;
    customerPhone: string;
    customerName?: string;
    purpose: string;
    notifyUrl: string;
    returnUrl: string;
  }): Promise<{ linkId: string; linkUrl: string; qrCode: string | null }> {
    const body = {
      link_id: params.linkId,
      link_amount: Number(params.amount.toFixed(2)),
      link_currency: 'INR',
      link_purpose: params.purpose,
      customer_details: {
        customer_phone: params.customerPhone,
        ...(params.customerName ? { customer_name: params.customerName } : {}),
      },
      link_notify: { send_sms: false, send_email: false },
      link_meta: { return_url: params.returnUrl, notify_url: params.notifyUrl, upi_intent: true },
      link_auto_reminders: false,
    };
    const { data } = await axios.post(`${this.baseUrl}/links`, body, {
      headers: this.headers(),
      timeout: 15000,
    });
    return {
      linkId: data.link_id,
      linkUrl: data.link_url,
      qrCode: data.link_qrcode ?? null,
    };
  }

  /** Fetch a payment link's status (LINK paid?). */
  async getPaymentLink(linkId: string): Promise<{ linkId: string; linkStatus: string; isPaid: boolean; amountPaid: number }> {
    const { data } = await axios.get(`${this.baseUrl}/links/${linkId}`, {
      headers: this.headers(),
      timeout: 15000,
    });
    return {
      linkId: data.link_id,
      linkStatus: data.link_status, // ACTIVE | PAID | PARTIALLY_PAID | EXPIRED | CANCELLED
      isPaid: data.link_status === 'PAID',
      amountPaid: Number(data.link_amount_paid) || 0,
    };
  }

  /**
   * Verify a Cashfree webhook signature.
   * Signature = base64( HMAC-SHA256( timestamp + rawBody, secretKey ) ).
   * `rawBody` MUST be the exact raw request body string.
   */
  verifyWebhookSignature(rawBody: string, signature: string, timestamp: string): boolean {
    if (!signature || !timestamp || !this.secretKey) return false;
    try {
      const payload = `${timestamp}${rawBody}`;
      const expected = crypto
        .createHmac('sha256', this.secretKey)
        .update(payload)
        .digest('base64');
      // Constant-time compare
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (err: any) {
      this.logger.warn(`Cashfree webhook signature verify failed: ${err?.message}`);
      return false;
    }
  }

  /** JS SDK mode string for the client checkout page. */
  get sdkMode(): string {
    return this.mode;
  }
}
