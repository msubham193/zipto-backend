import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Payment, PaymentMethod, PaymentStatus } from './entities/payment.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { InitiatePaymentDto, CashPaymentDto } from './dto/payment.dto';
import { HdfcPaymentService } from '../../services/hdfc-payment.service';
import { CashfreeService } from '../../services/cashfree.service';
import { NotificationService } from '../notification/notification.service';
import { TransactionLogService } from '../transaction-log/transaction-log.service';
import { BookingGateway } from '../booking/booking.gateway';
import { SystemSettingsService } from '../settings/system-settings.service';
import { DriverService } from '../driver/driver.service';
import { JwtService } from '@nestjs/jwt';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { buildInvoiceData, renderInvoiceHtml, buildInvoicePdf, invoiceFileName } from '../../common/utils/invoice.util';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private configService: ConfigService,
    private hdfcService: HdfcPaymentService,
    private cashfreeService: CashfreeService,
    private notificationService: NotificationService,
    private bookingGateway: BookingGateway,
    private transactionLog: TransactionLogService,
    private systemSettings: SystemSettingsService,
    private driverService: DriverService,
    private jwtService: JwtService,
  ) {}

  /** Public backend base (incl. /api) used for Cashfree return/notify URLs. */
  private publicBase(): string {
    return (
      this.configService.get<string>('HDFC_REDIRECT_BASE_URL') ||
      process.env.HDFC_REDIRECT_BASE_URL ||
      'https://api.ridezipto.com/api'
    ).replace(/\/+$/, '');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HDFC SmartGateway — initiate payment
  // ─────────────────────────────────────────────────────────────────────────

  async initiatePayment(userId: string, dto: InitiatePaymentDto) {
    const { booking_id, amount } = dto;
    if (!amount || amount <= 0) throw new BadRequestException('Invalid payment amount');

    const booking = await this.bookingRepository.findOne({ where: { id: booking_id } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.customer_id !== userId) throw new BadRequestException('Access denied');
    if (booking.status === BookingStatus.CANCELLED) {
      throw new BadRequestException('Cannot pay for a cancelled booking');
    }

    const existing = await this.paymentRepository.findOne({
      where: { booking_id, payment_status: PaymentStatus.COMPLETED },
    });
    if (existing) throw new BadRequestException('Payment already completed for this booking');

    // Reuse pending HDFC order if one exists and isn't expired
    const pending = await this.paymentRepository.findOne({
      where: { booking_id, payment_status: PaymentStatus.PENDING },
    });
    if (pending?.hdfc_order_id) {
      const req = this.hdfcService.buildRequest({
        orderId: pending.hdfc_order_id,
        amount,
        merchantRef: `BOOKING:${booking_id}`,
      });
      return { ...req, orderId: pending.hdfc_order_id, amount };
    }

    const orderId = this.hdfcService.generateOrderId();
    const req = this.hdfcService.buildRequest({
      orderId,
      amount,
      merchantRef: `BOOKING:${booking_id}`,
    });

    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      hdfc_order_id: orderId,
    });
    await this.paymentRepository.save(payment);

    this.logger.log(`HDFC payment initiated: ${orderId} for booking ${booking_id}`);
    return { ...req, orderId, amount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HDFC SmartGateway — process encrypted response (called by HDFC redirect)
  // ─────────────────────────────────────────────────────────────────────────

  async handleHdfcResponse(encResp: string): Promise<string> {
    const result = this.hdfcService.parseResponse(encResp);
    this.logger.log(
      `HDFC response: orderId=${result.orderId} status=${result.orderStatus} ref=${result.bankRefNo}`,
    );

    const [refType, refId] = result.merchantRef.split(':');

    if (result.orderStatus === 'Success') {
      if (refType === 'BOOKING' && refId) {
        await this.markBookingPaymentComplete(result.orderId, result, refId);
      } else if (refType === 'WALLET' && refId) {
        await this.markWalletPaymentComplete(result, refId);
      }
    } else {
      await this.paymentRepository.update(
        { hdfc_order_id: result.orderId },
        { payment_status: PaymentStatus.FAILED, hdfc_status_code: result.statusCode },
      );
    }

    const base = this.configService.get<string>('HDFC_REDIRECT_BASE_URL') ?? 'https://api.ridezipto.com/api';
    const resultUrl = `${base}/payment/hdfc/result?status=${encodeURIComponent(result.orderStatus.toLowerCase())}&orderId=${encodeURIComponent(result.orderId)}&amount=${encodeURIComponent(result.amount)}&ref=${encodeURIComponent(result.bankRefNo || result.trackingId)}`;

    // Return HTML that the WebView sees — JS redirect makes URL detectable
    return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"/><title>Bookfleet Payment</title></head>
  <body>
    <script>window.location.replace(${JSON.stringify(resultUrl)});</script>
    <noscript><meta http-equiv="refresh" content="0;url=${resultUrl}"/></noscript>
    <p>Processing...</p>
  </body>
</html>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Payment status polling endpoint (app polls after WebView closes)
  // ─────────────────────────────────────────────────────────────────────────

  async getPaymentStatus(bookingId: string, userId: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.customer_id !== userId) throw new BadRequestException('Access denied');

    let payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      order: { created_at: 'DESC' },
    });

    // If the pending payment is a Cashfree payment link (delivery QR), confirm
    // its status with Cashfree so a paid link reflects without relying on a webhook.
    if (
      payment &&
      payment.payment_status === PaymentStatus.PENDING &&
      payment.payment_link_url &&
      payment.cashfree_order_id
    ) {
      try {
        const link = await this.cashfreeService.getPaymentLink(payment.cashfree_order_id);
        if (link.isPaid) {
          await this.markCashfreePaymentComplete(payment.cashfree_order_id, undefined, Number(payment.amount));
          payment = await this.paymentRepository.findOne({
            where: { booking_id: bookingId },
            order: { created_at: 'DESC' },
          });
        }
      } catch (err: any) {
        this.logger.warn(`[link] status check failed for booking ${bookingId}: ${err?.message}`);
      }
    }

    return {
      booking_id: bookingId,
      status: payment?.payment_status ?? 'not_found',
      amount: payment?.amount,
      hdfc_tracking_id: payment?.hdfc_tracking_id,
      hdfc_bank_ref_no: payment?.hdfc_bank_ref_no,
    };
  }

  /**
   * Driver-side reconciliation: if the booking's latest payment is a PENDING
   * Cashfree payment link (the delivery QR), verify it with Cashfree and mark it
   * complete if paid — so the rider auto-sees "Paid" without waiting on the
   * webhook. Best-effort and idempotent. No auth check (the driver poll only
   * ever reaches their own active booking).
   */
  async verifyPendingLinkForBooking(bookingId: string): Promise<void> {
    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      order: { created_at: 'DESC' },
    });
    if (
      !payment ||
      payment.payment_status !== PaymentStatus.PENDING ||
      !payment.cashfree_order_id
    ) {
      return;
    }
    try {
      // A payment_link_url means it's a Cashfree LINK (verify via getPaymentLink);
      // otherwise it's a direct UPI-QR ORDER (verify via getOrder).
      const isPaid = payment.payment_link_url
        ? (await this.cashfreeService.getPaymentLink(payment.cashfree_order_id)).isPaid
        : (await this.cashfreeService.getOrder(payment.cashfree_order_id)).isPaid;
      if (isPaid) {
        await this.markCashfreePaymentComplete(
          payment.cashfree_order_id,
          undefined,
          Number(payment.amount),
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[verify] driver-side status check failed for booking ${bookingId}: ${err?.message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cashfree PG — initiate payment (returns a checkout URL for the WebView)
  // ─────────────────────────────────────────────────────────────────────────

  async initiateCashfree(userId: string, dto: InitiatePaymentDto) {
    const { booking_id, amount } = dto;
    if (!amount || amount <= 0) throw new BadRequestException('Invalid payment amount');
    if (!this.cashfreeService.isEnabled) {
      throw new BadRequestException('Online payment is temporarily unavailable');
    }

    const booking = await this.bookingRepository.findOne({
      where: { id: booking_id },
      relations: ['customer'],
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.customer_id !== userId) throw new BadRequestException('Access denied');
    if (booking.status === BookingStatus.CANCELLED) {
      throw new BadRequestException('Cannot pay for a cancelled booking');
    }

    const already = await this.paymentRepository.findOne({
      where: { booking_id, payment_status: PaymentStatus.COMPLETED },
    });
    if (already) throw new BadRequestException('Payment already completed for this booking');

    const orderId = this.cashfreeService.generateOrderId();
    const base = this.publicBase();

    const customerPhone =
      (booking.mobile_number || booking.customer?.phone || '').replace(/\D/g, '').slice(-10) ||
      '9999999999';

    const { paymentSessionId } = await this.cashfreeService.createOrder({
      orderId,
      amount,
      customerId: userId,
      customerPhone,
      customerEmail: booking.customer?.email || undefined,
      returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
      notifyUrl: `${base}/payment/cashfree/webhook`,
      tags: { booking_id },
    });

    // Persist a fresh pending payment for this attempt.
    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      cashfree_order_id: orderId,
    });
    await this.paymentRepository.save(payment);

    this.logger.log(`Cashfree order created: ${orderId} for booking ${booking_id}`);

    return {
      order_id: orderId,
      payment_session_id: paymentSessionId,
      mode: this.cashfreeService.mode,
      // The app opens this in a WebView; Cashfree redirects to the return_url on finish.
      checkout_url:
        `${base}/payment/cashfree/checkout` +
        `?sid=${encodeURIComponent(paymentSessionId)}&order_id=${encodeURIComponent(orderId)}`,
    };
  }

  /**
   * Create a Cashfree Payment Link for a booking — the rider shows the returned
   * URL as a QR for the customer to pay online at delivery. Reuses an existing
   * pending link if present.
   */
  async createBookingPaymentLink(userId: string, bookingId: string, amount: number) {
    if (!amount || amount <= 0) throw new BadRequestException('Invalid payment amount');
    if (!this.cashfreeService.isEnabled) {
      throw new BadRequestException('Online payment is temporarily unavailable');
    }

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['customer'],
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.driver_id !== userId && booking.customer_id !== userId) {
      throw new BadRequestException('Access denied');
    }

    const completed = await this.paymentRepository.findOne({
      where: { booking_id: bookingId, payment_status: PaymentStatus.COMPLETED },
    });
    if (completed) throw new BadRequestException('Payment already completed for this booking');

    // Reconcile any existing pending payment with Cashfree first — if it was
    // already paid, surface that instead of creating a brand-new QR.
    const existingPending = await this.paymentRepository.findOne({
      where: { booking_id: bookingId, payment_status: PaymentStatus.PENDING },
    });
    if (existingPending) {
      await this.verifyPendingLinkForBooking(bookingId).catch(() => {});
      const nowPaid = await this.paymentRepository.findOne({
        where: { booking_id: bookingId, payment_status: PaymentStatus.COMPLETED },
      });
      if (nowPaid) throw new BadRequestException('Payment already completed for this booking');
    }

    const base = this.publicBase();
    const phone = (booking.mobile_number || (booking as any).receiver_phone || booking.customer?.phone || '')
      .replace(/\D/g, '').slice(-10) || '9999999999';

    // ── Preferred: Cashfree SoftPOS dynamic QR (base64 PNG; scanning opens the
    //    UPI app DIRECTLY — no hosted checkout, no "redirecting" warning). Each
    //    rider has a terminal (created lazily). Gated by CASHFREE_SOFTPOS_ENABLED. ──
    if (this.cashfreeService.softposEnabled && booking.driver_id) {
      try {
        const cfTerminalId = await this.driverService.ensureDriverTerminal(booking.driver_id);
        if (cfTerminalId) {
          const orderId = this.cashfreeService.generateOrderId();
          const order = await this.cashfreeService.createTerminalOrder({
            orderId,
            amount,
            customerId: `cust_${bookingId.replace(/-/g, '').slice(-12)}`,
            customerPhone: phone,
            cfTerminalId,
            notifyUrl: `${base}/payment/cashfree/webhook`,
            returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
          });
          if (order.cfOrderId) {
            const { qrcode } = await this.cashfreeService.createTerminalTransaction({
              cfOrderId: order.cfOrderId,
              cfTerminalId,
            });
            if (qrcode) {
              await this.paymentRepository.update(
                { booking_id: bookingId, payment_status: PaymentStatus.PENDING, payment_method: PaymentMethod.UPI },
                { payment_status: PaymentStatus.FAILED },
              );
              const payment = this.paymentRepository.create({
                booking_id: bookingId,
                amount,
                payment_method: PaymentMethod.UPI,
                payment_status: PaymentStatus.PENDING,
                cashfree_order_id: orderId, // tracked via getOrder()/webhook like any order
              });
              await this.paymentRepository.save(payment);
              this.logger.log(`[softpos] qr minted order=${orderId} booking=${bookingId} ₹${amount}`);
              const dataUri = qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode}`;
              return { qrcode: dataUri, qr_is_image: true, order_id: orderId, short_url: null, amount };
            }
          }
          this.logger.warn(`[softpos] no qr for booking=${bookingId} — falling back to UPI QR / link`);
        }
      } catch (err: any) {
        const cf = err?.response?.data;
        this.logger.warn(
          `[softpos] failed for booking=${bookingId}: status=${err?.response?.status} ` +
            `msg=${err?.message} cashfree=${cf ? JSON.stringify(cf) : 'n/a'} — falling back`,
        );
      }
    }

    // ── Preferred: a direct UPI QR (scanning opens the UPI app, NO external page) ──
    try {
      const orderId = this.cashfreeService.generateOrderId();
      const { qrcode } = await this.cashfreeService.createUpiQr({
        orderId,
        amount,
        customerId: `cust_${bookingId.replace(/-/g, '').slice(-12)}`,
        customerPhone: phone,
        notifyUrl: `${base}/payment/cashfree/webhook`,
        returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
      });
      if (qrcode) {
        // Supersede any stale pending payment so only the latest order is open.
        await this.paymentRepository.update(
          { booking_id: bookingId, payment_status: PaymentStatus.PENDING, payment_method: PaymentMethod.UPI },
          { payment_status: PaymentStatus.FAILED },
        );
        const payment = this.paymentRepository.create({
          booking_id: bookingId,
          amount,
          payment_method: PaymentMethod.UPI,
          payment_status: PaymentStatus.PENDING,
          cashfree_order_id: orderId, // order (no payment_link_url) → verified via getOrder
        });
        await this.paymentRepository.save(payment);
        this.logger.log(`[upiQr] order=${orderId} booking=${bookingId} ₹${amount}`);
        return { qrcode, order_id: orderId, short_url: null, amount };
      }
      this.logger.warn(`[upiQr] no qrcode for booking=${bookingId} — falling back to payment link`);
    } catch (err: any) {
      // Capture Cashfree's actual error body so we can see WHY the UPI QR failed
      // (e.g. endpoint/version mismatch, UPI-QR not enabled on the account).
      const cf = err?.response?.data;
      this.logger.warn(
        `[upiQr] failed for booking=${bookingId}: status=${err?.response?.status} ` +
          `msg=${err?.message} cashfree=${cf ? JSON.stringify(cf) : 'n/a'} — falling back to payment link`,
      );
    }

    // ── Fallback: Cashfree payment LINK (web page) ──
    const pending = await this.paymentRepository.findOne({
      where: { booking_id: bookingId, payment_status: PaymentStatus.PENDING },
    });
    if (pending?.payment_link_url) {
      return { short_url: pending.payment_link_url, qrcode: null, amount: Number(pending.amount) || amount };
    }
    const linkId = `zlink${bookingId.replace(/-/g, '').slice(-10)}${Date.now().toString().slice(-6)}`;
    const { linkUrl } = await this.cashfreeService.createPaymentLink({
      linkId,
      amount,
      customerPhone: phone,
      customerName: booking.customer?.name,
      purpose: `Zipto delivery ${bookingId.slice(-6)}`,
      notifyUrl: `${base}/payment/cashfree/webhook`,
      returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
    });
    const linkPayment = this.paymentRepository.create({
      booking_id: bookingId,
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      cashfree_order_id: linkId,
      payment_link_url: linkUrl,
    });
    await this.paymentRepository.save(linkPayment);
    this.logger.log(`[link] Cashfree payment link created: ${linkId} booking=${bookingId} ₹${amount}`);
    return { short_url: linkUrl, qrcode: null, amount };
  }

  /** HTML page (loaded in the app WebView) that launches the Cashfree checkout. */
  buildCashfreeCheckoutHtml(sessionId: string): string {
    const mode = this.cashfreeService.sdkMode;
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Bookfleet Payment</title>
    <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
    <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f9fafb;color:#6b7280}</style>
  </head>
  <body>
    <p>Loading secure payment…</p>
    <script>
      try {
        var cashfree = Cashfree({ mode: ${JSON.stringify(mode)} });
        cashfree.checkout({ paymentSessionId: ${JSON.stringify(sessionId)}, redirectTarget: "_self" });
      } catch (e) {
        document.body.innerText = "Unable to start payment. Please go back and try again.";
      }
    </script>
  </body>
</html>`;
  }

  /**
   * Cashfree return URL (WebView detection point). Verifies the order
   * server-side, marks the booking paid if successful, and renders a result page.
   */
  async handleCashfreeReturn(orderId: string): Promise<string> {
    let isSuccess = false;
    let amount = 0;
    try {
      const order = await this.cashfreeService.getOrder(orderId);
      amount = order.orderAmount;
      if (order.isPaid) {
        await this.markCashfreePaymentComplete(orderId, undefined, order.orderAmount);
        isSuccess = true;
      }
    } catch (err: any) {
      this.logger.warn(`Cashfree return verify failed for ${orderId}: ${err?.message}`);
    }

    const status = isSuccess ? 'success' : 'failed';
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Bookfleet Payment ${isSuccess ? 'Successful' : 'Failed'}</title>
    <!-- Marker URL the WebView detects -->
    <script>window.__ZIPTO_PAYMENT__ = ${JSON.stringify({ status, orderId, amount })};</script>
    <style>
      body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f9fafb}
      .card{text-align:center;padding:32px;border-radius:16px;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.08)}
      .icon{font-size:64px;margin-bottom:16px}
      h2{margin:0 0 8px;color:${isSuccess ? '#16a34a' : '#dc2626'}}
      p{color:#6b7280;margin:0;font-size:14px}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${isSuccess ? '✅' : '⚠️'}</div>
      <h2>${isSuccess ? 'Payment Successful' : 'Payment Failed'}</h2>
      <p>${isSuccess ? `₹${amount} paid successfully` : 'Please go back and try again'}</p>
    </div>
  </body>
</html>`;
  }

  /**
   * Cashfree webhook (authoritative). Verifies signature, then marks the
   * booking paid on a successful payment event.
   */
  async handleCashfreeWebhook(rawBody: string, signature: string, timestamp: string): Promise<void> {
    const ok = this.cashfreeService.verifyWebhookSignature(rawBody, signature, timestamp);
    if (!ok) {
      this.logger.warn('Cashfree webhook signature INVALID — ignoring');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logger.warn('Cashfree webhook body not JSON');
      return;
    }

    const type = payload?.type;
    const orderId = payload?.data?.order?.order_id;
    const paymentStatus = payload?.data?.payment?.payment_status; // SUCCESS | FAILED | ...
    const paymentId = payload?.data?.payment?.cf_payment_id;
    const orderAmount = Number(payload?.data?.order?.order_amount) || 0;
    const customerId = payload?.data?.customer_details?.customer_id;
    const purpose = payload?.data?.order?.order_tags?.purpose;

    this.logger.log(`Cashfree webhook: type=${type} order=${orderId} payment=${paymentStatus} purpose=${purpose ?? 'booking'}`);

    if (!orderId) return;

    if (paymentStatus === 'SUCCESS' || type === 'PAYMENT_SUCCESS_WEBHOOK') {
      // Wallet top-up (customer add-money) — no booking; credit the wallet.
      if (purpose === 'customer_wallet' && customerId) {
        await this.creditWalletForCashfreeOrder(customerId, orderId, orderAmount);
        return;
      }
      // Driver wallet top-up. Normally confirmed by the rider app's verify call,
      // but we credit here too as an authoritative fallback so a paid top-up is
      // never stranded if the app closed before verifying (idempotent).
      if (purpose === 'driver_topup') {
        await this.driverService.creditCashfreeTopupFromWebhook(orderId);
        return;
      }
      // Otherwise it's a booking payment.
      await this.markCashfreePaymentComplete(orderId, paymentId ? String(paymentId) : undefined, orderAmount);
    } else if (paymentStatus === 'FAILED' || type === 'PAYMENT_FAILED_WEBHOOK') {
      await this.paymentRepository.update(
        { cashfree_order_id: orderId },
        { payment_status: PaymentStatus.FAILED },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cashfree — customer WALLET top-up (add money)
  // ─────────────────────────────────────────────────────────────────────────

  async initiateCashfreeWallet(userId: string, amount: number) {
    if (!amount || amount < 10) throw new BadRequestException('Minimum top-up is ₹10');
    if (amount > 50000) throw new BadRequestException('Maximum top-up is ₹50,000');
    if (!this.cashfreeService.isEnabled) {
      throw new BadRequestException('Online payment is temporarily unavailable');
    }

    const user = await this.bookingRepository.manager.query(
      `SELECT phone, email FROM users WHERE id = $1`, [userId],
    );
    const phone = (user?.[0]?.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';

    const orderId = this.cashfreeService.generateOrderId();
    const base = this.publicBase();

    const { paymentSessionId } = await this.cashfreeService.createOrder({
      orderId,
      amount,
      customerId: userId,
      customerPhone: phone,
      customerEmail: user?.[0]?.email || undefined,
      returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
      notifyUrl: `${base}/payment/cashfree/webhook`,
      tags: { purpose: 'customer_wallet', user_id: userId },
    });

    // Payment row (no booking) tracks this wallet top-up for idempotency.
    const payment = this.paymentRepository.create({
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      cashfree_order_id: orderId,
    });
    await this.paymentRepository.save(payment);

    this.logger.log(`[wallet] Cashfree order created: ${orderId} user=${userId} ₹${amount}`);

    return {
      order_id: orderId,
      payment_session_id: paymentSessionId,
      mode: this.cashfreeService.mode,
    };
  }

  async verifyCashfreeWallet(userId: string, orderId: string): Promise<{ new_balance: number | null; status: string }> {
    const order = await this.cashfreeService.getOrder(orderId);
    // Ownership guard — the order must belong to the authenticated user.
    if (order.customerId && order.customerId !== userId) {
      throw new BadRequestException('Order does not belong to you');
    }
    if (!order.isPaid) {
      return { new_balance: null, status: order.orderStatus };
    }
    const newBalance = await this.creditWalletForCashfreeOrder(userId, orderId, order.orderAmount);
    return { new_balance: newBalance, status: 'approved' };
  }

  /**
   * Idempotently credit a customer's wallet for a paid Cashfree wallet-top-up
   * order. The atomic Payment PENDING→COMPLETED transition ensures the credit
   * happens exactly once whether triggered by the app's verify call or the
   * webhook. Returns the resulting balance.
   */
  private async creditWalletForCashfreeOrder(userId: string, orderId: string, amount: number): Promise<number | null> {
    let newBalance: number | null = null;
    let credited = false;
    await this.paymentRepository.manager.transaction(async manager => {
      const res = await manager.update(
        Payment,
        { cashfree_order_id: orderId, payment_status: PaymentStatus.PENDING },
        { payment_status: PaymentStatus.COMPLETED, transaction_id: orderId },
      );
      if (res.affected !== 1) return; // already credited by the other path
      const rows: { wallet_balance: string }[] = await manager.query(
        `UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2 RETURNING wallet_balance`,
        [amount, userId],
      );
      newBalance = rows.length ? Number(rows[0].wallet_balance) : null;
      credited = true;
      this.logger.log(`[wallet] Cashfree credit ₹${amount} user=${userId} order=${orderId} → balance=${newBalance}`);
    });

    if (newBalance === null) {
      const rows: { wallet_balance: string }[] = await this.paymentRepository.manager.query(
        `SELECT wallet_balance FROM users WHERE id = $1`, [userId],
      );
      newBalance = rows.length ? Number(rows[0].wallet_balance) : null;
    }

    if (credited) {
      this.bookingGateway.notifyUser(userId, 'wallet_topped_up', { amount, newBalance });
      this.transactionLog.record({
        userId,
        category: 'wallet_topup',
        direction: 'credit',
        amount,
        gateway: 'cashfree',
        gatewayRef: orderId,
        balanceAfter: newBalance,
        description: 'Wallet top-up (Cashfree)',
      }).catch(() => {});
    }
    return newBalance;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cash payment (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  async recordCashPayment(userId: string, dto: CashPaymentDto) {
    const { booking_id, amount } = dto;

    const booking = await this.bookingRepository.findOne({ where: { id: booking_id } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.driver_id !== userId && booking.customer_id !== userId) {
      throw new BadRequestException('Access denied');
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException('Can only record payment for completed bookings');
    }

    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.CASH,
      payment_status: PaymentStatus.COMPLETED,
      transaction_id: `cash_${Date.now()}`,
    });
    await this.paymentRepository.save(payment);

    this.transactionLog.record({
      userId: booking.customer_id ?? null,
      counterpartyUserId: booking.driver_id ?? null,
      category: 'booking_payment',
      direction: 'debit',
      amount,
      gateway: 'cash',
      gatewayRef: payment.transaction_id,
      bookingId: booking_id,
      description: 'Cash booking payment',
    }).catch(() => {});

    if (booking.driver_id) {
      this.notificationService
        .notifyPaymentReceived(booking.driver_id, amount, booking_id)
        .catch(() => {});
    }
    return payment;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // History / Invoice (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  async getHistory(userId: string, page: number = 1, limit: number = 10) {
    const [payments, total] = await this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.booking', 'booking')
      .where('booking.customer_id = :userId', { userId })
      .orWhere('booking.driver_id = :userId', { userId })
      .orderBy('payment.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { payments, ...getPaginationMeta(total, page, limit) };
  }

  async generateInvoice(bookingId: string, userId: string) {
    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['booking', 'booking.customer', 'booking.driver'],
    });
    if (!payment) throw new NotFoundException('Payment not found for this booking');
    if (payment.booking.customer_id !== userId && payment.booking.driver_id !== userId) {
      throw new BadRequestException('Access denied');
    }

    const tax = await this.systemSettings.getTaxSettings();
    return buildInvoiceData(payment.booking, payment, tax as any);
  }

  /**
   * Render the invoice as a print-ready HTML page for the in-app "Download
   * Invoice" link. Auth is via a short JWT passed in the URL (`token`) because
   * the page is opened in the device browser, which can't send the bearer
   * header. The token's user must own the booking (customer or driver).
   */
  async getInvoiceHtmlByToken(bookingId: string, token: string): Promise<string> {
    if (!token) throw new BadRequestException('Missing token');
    let userId: string;
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });
      userId = payload?.sub;
    } catch {
      throw new BadRequestException('Invalid or expired link');
    }
    if (!userId) throw new BadRequestException('Invalid link');

    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['booking', 'booking.customer', 'booking.driver'],
    });
    if (!payment || !payment.booking) throw new NotFoundException('Invoice not found');
    if (payment.booking.customer_id !== userId && payment.booking.driver_id !== userId) {
      throw new BadRequestException('Access denied');
    }

    const tax = await this.systemSettings.getTaxSettings();
    return renderInvoiceHtml(buildInvoiceData(payment.booking, payment, tax as any));
  }

  /**
   * Build the invoice as a downloadable PDF for the in-app "Download Invoice"
   * button — served with Content-Disposition: attachment so it downloads
   * reliably on every phone (no dependence on window.print). Auth via the JWT
   * in the URL (browser can't send the bearer header).
   */
  async getInvoicePdfByToken(bookingId: string, token: string): Promise<{ buffer: Buffer; filename: string }> {
    if (!token) throw new BadRequestException('Missing token');
    let userId: string;
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });
      userId = payload?.sub;
    } catch {
      throw new BadRequestException('Invalid or expired link');
    }
    if (!userId) throw new BadRequestException('Invalid link');

    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['booking', 'booking.customer', 'booking.driver'],
    });
    if (!payment || !payment.booking) throw new NotFoundException('Invoice not found');
    if (payment.booking.customer_id !== userId && payment.booking.driver_id !== userId) {
      throw new BadRequestException('Access denied');
    }

    const tax = await this.systemSettings.getTaxSettings();
    const invoice = buildInvoiceData(payment.booking, payment, tax as any);
    const buffer = await buildInvoicePdf(invoice);
    return { buffer, filename: invoiceFileName(invoice) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async markBookingPaymentComplete(
    hdfcOrderId: string,
    result: { trackingId: string; bankRefNo: string; statusCode: string; amount: string },
    bookingId: string,
  ) {
    const payment = await this.paymentRepository.findOne({ where: { hdfc_order_id: hdfcOrderId } });
    if (payment?.payment_status === PaymentStatus.COMPLETED) return; // idempotent

    if (payment) {
      payment.payment_status = PaymentStatus.COMPLETED;
      payment.hdfc_tracking_id = result.trackingId;
      payment.hdfc_bank_ref_no = result.bankRefNo;
      payment.hdfc_status_code = result.statusCode;
      payment.transaction_id = result.trackingId;
      if (!payment.amount && result.amount) payment.amount = parseFloat(result.amount);
      await this.paymentRepository.save(payment);
    } else {
      const newPayment = this.paymentRepository.create({
        booking_id: bookingId,
        amount: parseFloat(result.amount) || 0,
        payment_method: PaymentMethod.UPI,
        payment_status: PaymentStatus.COMPLETED,
        hdfc_order_id: hdfcOrderId,
        hdfc_tracking_id: result.trackingId,
        hdfc_bank_ref_no: result.bankRefNo,
        hdfc_status_code: result.statusCode,
        transaction_id: result.trackingId,
      });
      await this.paymentRepository.save(newPayment);
    }

    this.logger.log(`Booking payment complete: booking=${bookingId} tracking=${result.trackingId}`);

    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (booking?.driver_id) {
      this.notificationService
        .notifyPaymentReceived(booking.driver_id, parseFloat(result.amount) || 0, bookingId)
        .catch(() => {});
      this.bookingGateway.notifyUser(booking.driver_id, 'payment_received', {
        bookingId,
        amount: parseFloat(result.amount) || 0,
      });
    }
    if (booking?.customer_id) {
      this.bookingGateway.notifyUser(booking.customer_id, 'payment_complete', {
        bookingId,
        status: 'success',
        amount: parseFloat(result.amount) || 0,
        trackingId: result.trackingId,
      });
    }
  }

  private async markCashfreePaymentComplete(
    cashfreeOrderId: string,
    cashfreePaymentId: string | undefined,
    amount: number,
  ) {
    const payment = await this.paymentRepository.findOne({
      where: { cashfree_order_id: cashfreeOrderId },
    });
    if (!payment) {
      this.logger.warn(`Cashfree complete: no payment row for order ${cashfreeOrderId}`);
      return;
    }
    if (payment.payment_status === PaymentStatus.COMPLETED) return; // idempotent

    payment.payment_status = PaymentStatus.COMPLETED;
    if (cashfreePaymentId) payment.cashfree_payment_id = cashfreePaymentId;
    payment.transaction_id = cashfreePaymentId || cashfreeOrderId;
    if ((!payment.amount || Number(payment.amount) <= 0) && amount > 0) payment.amount = amount;
    await this.paymentRepository.save(payment);

    const paidAmount = Number(payment.amount) || amount || 0;
    this.logger.log(`Cashfree payment complete: booking=${payment.booking_id} order=${cashfreeOrderId}`);

    const booking = await this.bookingRepository.findOne({ where: { id: payment.booking_id } });

    this.transactionLog.record({
      userId: booking?.customer_id ?? null,
      counterpartyUserId: booking?.driver_id ?? null,
      category: 'booking_payment',
      direction: 'debit',
      amount: paidAmount,
      gateway: 'cashfree',
      gatewayRef: cashfreePaymentId || cashfreeOrderId,
      bookingId: payment.booking_id,
      description: 'Online booking payment (Cashfree)',
    }).catch(() => {});

    if (booking?.driver_id) {
      this.notificationService
        .notifyPaymentReceived(booking.driver_id, paidAmount, payment.booking_id)
        .catch(() => {});
      this.bookingGateway.notifyUser(booking.driver_id, 'payment_received', {
        bookingId: payment.booking_id,
        amount: paidAmount,
      });
    }
    if (booking?.customer_id) {
      this.bookingGateway.notifyUser(booking.customer_id, 'payment_complete', {
        bookingId: payment.booking_id,
        status: 'success',
        amount: paidAmount,
        trackingId: payment.transaction_id,
      });
    }
  }

  private async markWalletPaymentComplete(
    result: { orderId: string; trackingId: string; bankRefNo: string; statusCode: string; amount: string },
    userId: string,
  ) {
    const amount = parseFloat(result.amount) || 0;
    if (amount <= 0) return;

    await this.paymentRepository.manager.transaction(async manager => {
      const existing = await manager.findOne(Payment, {
        where: { hdfc_order_id: result.orderId, payment_status: PaymentStatus.COMPLETED },
      });
      if (existing) return; // idempotent

      const payment = manager.create(Payment, {
        amount,
        payment_method: PaymentMethod.UPI,
        payment_status: PaymentStatus.COMPLETED,
        hdfc_order_id: result.orderId,
        hdfc_tracking_id: result.trackingId,
        hdfc_bank_ref_no: result.bankRefNo,
        hdfc_status_code: result.statusCode,
        transaction_id: result.trackingId,
      });
      await manager.save(payment);

      await manager.query(
        `UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2`,
        [amount, userId],
      );
    });

    this.logger.log(`Wallet top-up complete: userId=${userId} amount=₹${amount} tracking=${result.trackingId}`);

    this.bookingGateway.notifyUser(userId, 'wallet_topped_up', {
      amount,
      trackingId: result.trackingId,
      newBalance: null,
    });
  }
}
