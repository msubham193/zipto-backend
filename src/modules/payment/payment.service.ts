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
import { NotificationService } from '../notification/notification.service';
import { BookingGateway } from '../booking/booking.gateway';
import { getPaginationMeta } from '../../common/utils/helpers.util';

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
    private notificationService: NotificationService,
    private bookingGateway: BookingGateway,
  ) {}

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
  <head><meta charset="utf-8"/><title>Zipto Payment</title></head>
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

    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      order: { created_at: 'DESC' },
    });

    return {
      booking_id: bookingId,
      status: payment?.payment_status ?? 'not_found',
      amount: payment?.amount,
      hdfc_tracking_id: payment?.hdfc_tracking_id,
      hdfc_bank_ref_no: payment?.hdfc_bank_ref_no,
    };
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
    return {
      message: 'Invoice generation coming soon',
      payment_id: payment.id,
      booking_id: bookingId,
      amount: payment.amount,
      status: payment.payment_status,
    };
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
