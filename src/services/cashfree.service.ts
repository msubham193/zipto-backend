import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

export interface CashfreeOrderResult {
  orderId: string;
  paymentSessionId: string;
  /** Cashfree's own numeric order id (string) — needed by the Terminal API. */
  cfOrderId?: string;
}

export interface CashfreeTerminal {
  cfTerminalId: string;
  terminalId: string;
  status: string;
}

export interface TerminalTxnResult {
  /** Base64-encoded PNG of the dynamic UPI QR (data-URI body, no prefix). */
  qrcode: string | null;
  cfPaymentId: string | null;
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
  /** Dedicated webhook signing secret (newer dashboards); falls back to secretKey. */
  private readonly webhookSecret: string;
  private readonly apiVersion: string;
  /** Newer API version required by the SoftPOS / Terminal endpoints. */
  private readonly softposApiVersion: string;
  /** Feature flag — SoftPOS (agent QR collection) must be enabled on the account. */
  private readonly softposEnabledFlag: boolean;
  /** terminal_type sent on the order's terminal object (AGENT | SPOS | STOREFRONT). */
  private readonly softposTerminalType: string;
  private readonly baseUrl: string;
  /** 'production' | 'sandbox' — drives both the API host and the JS SDK mode. */
  readonly mode: 'production' | 'sandbox';

  constructor(private readonly config: ConfigService) {
    this.appId = (process.env.CASHFREE_APP_ID || '').trim();
    this.secretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();
    this.webhookSecret = (process.env.CASHFREE_WEBHOOK_SECRET || '').trim() || this.secretKey;
    this.apiVersion = (process.env.CASHFREE_API_VERSION || '2023-08-01').trim();
    this.softposApiVersion = (process.env.CASHFREE_SOFTPOS_API_VERSION || '2025-01-01').trim();
    this.softposEnabledFlag = (process.env.CASHFREE_SOFTPOS_ENABLED || '').trim() === 'true';
    this.softposTerminalType = (process.env.CASHFREE_SOFTPOS_TERMINAL_TYPE || 'AGENT').trim();
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

  /** SoftPOS usable only when credentials exist AND the feature flag is on. */
  get softposEnabled(): boolean {
    return this.isEnabled && this.softposEnabledFlag;
  }

  private headers(apiVersion: string = this.apiVersion) {
    return {
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey,
      'x-api-version': apiVersion,
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
      cfOrderId: data.cf_order_id != null ? String(data.cf_order_id) : undefined,
    };
  }

  // ── SoftPOS / Terminal (agent QR collection) ────────────────────────────────

  /**
   * Create an order **linked to a SoftPOS terminal** (top-level `terminal`
   * object, x-api-version 2025-01-01). This is required before
   * createTerminalTransaction() — a plain /orders order created under the old
   * version is not visible to the Terminal API ("order_not_found").
   */
  async createTerminalOrder(params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerPhone: string;
    cfTerminalId: string;
    returnUrl: string;
    notifyUrl: string;
  }): Promise<CashfreeOrderResult> {
    const body = {
      order_id: params.orderId,
      order_amount: Number(params.amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        customer_id: params.customerId,
        customer_phone: params.customerPhone,
      },
      order_meta: {
        return_url: params.returnUrl,
        notify_url: params.notifyUrl,
      },
      terminal: {
        cf_terminal_id: Number(params.cfTerminalId),
        terminal_type: this.softposTerminalType,
      },
    };
    const { data } = await axios.post(`${this.baseUrl}/orders`, body, {
      headers: this.headers(this.softposApiVersion),
      timeout: 15000,
    });
    return {
      orderId: data.order_id,
      paymentSessionId: data.payment_session_id,
      cfOrderId: data.cf_order_id != null ? String(data.cf_order_id) : undefined,
    };
  }

  /**
   * Create a Cashfree SoftPOS terminal — one per delivery rider, created once
   * (idempotent on `terminalId`). The returned `cfTerminalId` is stored against
   * the driver and used to mint dynamic UPI QRs at delivery without any hosted
   * checkout page. Requires the SoftPOS product enabled on the account.
   */
  async createTerminal(params: {
    terminalId: string;
    terminalName: string;
    terminalEmail: string;
    terminalPhone: string;
  }): Promise<CashfreeTerminal> {
    const body = {
      terminal_id: params.terminalId,
      terminal_name: params.terminalName.slice(0, 100),
      terminal_email: params.terminalEmail.slice(0, 100),
      terminal_phone_no: params.terminalPhone.replace(/\D/g, '').slice(-10),
      terminal_type: 'AGENT',
    };
    const { data } = await axios.post(`${this.baseUrl}/terminal`, body, {
      headers: this.headers(this.softposApiVersion),
      timeout: 15000,
    });
    return {
      cfTerminalId: String(data.cf_terminal_id),
      terminalId: data.terminal_id,
      status: data.terminal_status,
    };
  }

  /**
   * Create a terminal transaction for an existing order and return a dynamic
   * UPI QR (base64 PNG). Scanning it opens the customer's UPI app directly — no
   * hosted checkout / no "redirecting to external website" warning. The order is
   * tracked normally, so the standard webhook / getOrder confirms payment.
   */
  async createTerminalTransaction(params: {
    cfOrderId: string;
    cfTerminalId: string;
  }): Promise<TerminalTxnResult> {
    const body = {
      cf_order_id: params.cfOrderId,
      cf_terminal_id: Number(params.cfTerminalId),
      payment_method: 'QR_CODE',
    };
    const { data } = await axios.post(`${this.baseUrl}/terminal/transactions`, body, {
      headers: this.headers(this.softposApiVersion),
      timeout: 15000,
    });
    const qrcode: string | null = data?.qrcode ?? data?.qr_payload ?? null;
    return {
      qrcode,
      cfPaymentId: data?.cf_payment_id != null ? String(data.cf_payment_id) : null,
    };
  }

  /**
   * Create an order and immediately request a UPI QR for it (channel=qrcode).
   * Returns the order id + the QR payload — a `upi://` string OR a base64 PNG
   * data-URI depending on the Cashfree API version. Scanning it opens the
   * customer's UPI app DIRECTLY (no external web page), and the order is tracked
   * so getOrder() can confirm it. Falls back to a null qrcode if the channel
   * isn't available (caller can then fall back to a payment link).
   */
  async createUpiQr(params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerPhone: string;
    returnUrl: string;
    notifyUrl: string;
  }): Promise<{ orderId: string; qrcode: string | null }> {
    const order = await this.createOrder({
      orderId: params.orderId,
      amount: params.amount,
      customerId: params.customerId,
      customerPhone: params.customerPhone,
      returnUrl: params.returnUrl,
      notifyUrl: params.notifyUrl,
    });

    const { data } = await axios.post(
      `${this.baseUrl}/orders/sessions`,
      {
        payment_session_id: order.paymentSessionId,
        payment_method: { upi: { channel: 'qrcode' } },
      },
      { headers: this.headers(), timeout: 15000 },
    );

    // The QR lives under data.payload.qrcode (base64 PNG data-URI or a upi://
    // string). Be defensive about the response shape across API versions.
    const qrcode: string | null =
      data?.data?.payload?.qrcode ??
      data?.data?.payload?.default ??
      data?.payload?.qrcode ??
      data?.qrcode ??
      null;

    this.logger.log(
      `[upiQr] order=${order.orderId} qrcode=${qrcode ? 'present' : 'MISSING'}`,
    );
    return { orderId: order.orderId, qrcode };
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
    if (!signature || !timestamp || !this.webhookSecret) return false;
    try {
      const payload = `${timestamp}${rawBody}`;
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
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
