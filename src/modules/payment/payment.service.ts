import {
  Injectable,
  NotFoundException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Payment, PaymentMethod, PaymentStatus } from './entities/payment.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { CreateOrderDto, VerifyPaymentDto, CashPaymentDto, CreatePaymentLinkDto } from './dto/payment.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { NotificationService } from '../notification/notification.service';
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private configService: ConfigService,
    private notificationService: NotificationService,
  ) {}

  /**
   * Create Razorpay order
   */
  async createOrder(userId: string, createOrderDto: CreateOrderDto) {
    try {
      const { booking_id, amount, payment_method } = createOrderDto;
      if (!amount || amount <= 0) throw new BadRequestException('Invalid payment amount');
      this.logger.log(
        `createOrder called - booking_id: ${booking_id ?? 'none'}, amount: ${amount}, userId: ${userId}`,
      );

      // When booking_id is provided, validate the booking exists and belongs to user
      if (booking_id) {
        const booking = await this.bookingRepository.findOne({ where: { id: booking_id } });
        if (!booking) throw new NotFoundException('Booking not found');
        if (booking.customer_id !== userId) throw new BadRequestException('You do not have access to this booking');
        if (booking.status === BookingStatus.CANCELLED) throw new BadRequestException('Cannot create payment for cancelled bookings');

        const existingPayment = await this.paymentRepository.findOne({ where: { booking_id } });
        if (existingPayment?.payment_status === PaymentStatus.COMPLETED) {
          throw new BadRequestException('Payment already completed for this booking');
        }
        if (existingPayment?.payment_status === PaymentStatus.PENDING && existingPayment.razorpay_order_id) {
          return {
            order_id: existingPayment.razorpay_order_id,
            amount: existingPayment.amount,
            currency: 'INR',
            key: this.configService.get('externalServices.razorpay.keyId'),
          };
        }
      }

      const keyId = this.configService.get<string>('externalServices.razorpay.keyId');
      const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret');

      if (!keyId || !keySecret) {
        this.logger.error('Razorpay credentials not configured');
        throw new BadRequestException('Payment gateway is not configured');
      }

      this.logger.log('Creating Razorpay order...');

      const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });

      // Use 1 rupee (100 paise) for test mode, store actual amount in DB
      const isTestMode = keyId.startsWith('rzp_test');
      const razorpayAmount = isTestMode ? 100 : Math.round(amount * 100);

      const order = await razorpay.orders.create({
        amount: razorpayAmount,
        currency: 'INR',
        receipt: booking_id,
      });

      this.logger.log(`Razorpay order created: ${order.id}`);

      // Create payment record
      const payment = this.paymentRepository.create({
        booking_id,
        amount,
        payment_method: payment_method || PaymentMethod.UPI,
        payment_status: PaymentStatus.PENDING,
        razorpay_order_id: order.id,
      });

      await this.paymentRepository.save(payment);

      this.logger.log(`Payment record saved for booking: ${booking_id}`);

      return {
        order_id: order.id,
        amount,
        currency: 'INR',
        key: keyId,
      };
    } catch (error: unknown) {
      this.logger.error(`createOrder error: ${JSON.stringify(error)}`);
      if (error instanceof HttpException) {
        throw error;
      }
      const msg = (error as Error)?.message || 'Failed to create payment order';
      throw new BadRequestException(msg);
    }
  }

  /**
   * Verify Razorpay payment
   */
  async verifyPayment(userId: string, verifyPaymentDto: VerifyPaymentDto) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_id } =
      verifyPaymentDto;

    // Verify Razorpay signature first (does not require a booking record)
    const razorpayKeySecret = this.configService.get<string>('externalServices.razorpay.keySecret');
    if (!razorpayKeySecret) {
      throw new BadRequestException('Razorpay key secret is not configured');
    }
    const generatedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      throw new BadRequestException('Invalid payment signature');
    }

    // Find or create payment record
    let payment = await this.paymentRepository.findOne({
      where: { razorpay_order_id },
      relations: booking_id ? ['booking'] : [],
    });

    if (payment) {
      payment.payment_status = PaymentStatus.COMPLETED;
      payment.razorpay_payment_id = razorpay_payment_id;
      payment.razorpay_signature = razorpay_signature;
      payment.transaction_id = razorpay_payment_id;
      if (booking_id && !payment.booking_id) payment.booking_id = booking_id;
    } else {
      // Pre-payment flow: no payment record exists yet — create one
      payment = this.paymentRepository.create({
        booking_id: booking_id ?? undefined,
        amount: 0,
        payment_method: PaymentMethod.UPI,
        payment_status: PaymentStatus.COMPLETED,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        transaction_id: razorpay_payment_id,
      });
    }

    await this.paymentRepository.save(payment);
    this.logger.log(`Payment verified: ${razorpay_payment_id} booking: ${booking_id ?? 'pre-booking'}`);

    return { payment };
  }

  /**
   * Record cash payment
   */
  async recordCashPayment(userId: string, cashPaymentDto: CashPaymentDto) {
    const { booking_id, amount } = cashPaymentDto;

    // Verify booking
    const booking = await this.bookingRepository.findOne({
      where: { id: booking_id },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Can be recorded by driver
    if (booking.driver_id !== userId && booking.customer_id !== userId) {
      throw new BadRequestException('You do not have access to this booking');
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException('Can only record payment for completed bookings');
    }

    // Create payment record
    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.CASH,
      payment_status: PaymentStatus.COMPLETED,
      transaction_id: `cash_${Date.now()}`,
    });

    await this.paymentRepository.save(payment);

    // Notify the driver
    if (booking.driver_id) {
      this.notificationService.notifyPaymentReceived(
        booking.driver_id,
        amount,
        booking_id,
      ).catch(() => {/* non-critical */});
    }

    return payment;
  }

  /**
   * Create Razorpay Payment Link — used by rider to generate a tracked QR for the customer/receiver
   */
  async createPaymentLink(userId: string, dto: CreatePaymentLinkDto) {
    const { booking_id, amount } = dto;

    const booking = await this.bookingRepository.findOne({ where: { id: booking_id } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.driver_id !== userId && booking.customer_id !== userId) {
      throw new BadRequestException('You do not have access to this booking');
    }

    const existingCompleted = await this.paymentRepository.findOne({
      where: { booking_id, payment_status: PaymentStatus.COMPLETED },
    });
    if (existingCompleted) throw new BadRequestException('Payment already completed for this booking');

    if (!amount || amount <= 0) throw new BadRequestException('Invalid payment amount');

    // Return existing pending payment link if one was already created
    const existingPending = await this.paymentRepository.findOne({
      where: { booking_id, payment_status: PaymentStatus.PENDING },
    });
    if (existingPending?.payment_link_url) {
      return { short_url: existingPending.payment_link_url, amount };
    }

    const keyId = this.configService.get<string>('externalServices.razorpay.keyId');
    const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret');
    if (!keyId || !keySecret) throw new BadRequestException('Payment gateway is not configured');

    const isTestMode = keyId.startsWith('rzp_test');

    if (isTestMode) {
      // Razorpay test-mode payment links produce unusable QR codes and invalid UPI IDs.
      // Auto-complete the payment so the driver can proceed to OTP-based delivery completion.
      const payment = this.paymentRepository.create({
        booking_id,
        amount,
        payment_method: PaymentMethod.UPI,
        payment_status: PaymentStatus.COMPLETED,
        razorpay_order_id: `test_mock_${Date.now()}`,
        transaction_id: `test_mock_${Date.now()}`,
      });
      await this.paymentRepository.save(payment);
      this.logger.log(`[TEST MODE] Mock payment auto-completed for booking: ${booking_id}`);
      return { short_url: null, is_test_mode: true, amount };
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const amountPaise = Math.round(amount * 100);

    let link: any;
    try {
      link = await razorpay.paymentLink.create({
        amount: amountPaise,
        currency: 'INR',
        description: `Zipto Delivery Payment — Booking #${booking_id.slice(-6).toUpperCase()}`,
        upi_link: true,
        reminder_enable: false,
        notify: { sms: false, email: false },
        reference_id: booking_id,
      });
    } catch (err: any) {
      this.logger.error(`Razorpay paymentLink.create failed: ${JSON.stringify(err)}`);
      throw new BadRequestException(err?.error?.description || 'Failed to create payment link. Please try again.');
    }

    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      razorpay_order_id: link.id,
      payment_link_url: link.short_url,
    });
    await this.paymentRepository.save(payment);

    this.logger.log(`Payment link created: ${link.id} for booking: ${booking_id}`);
    return { short_url: link.short_url, amount };
  }

  /**
   * Razorpay webhook — auto-confirms payment when receiver pays via Payment Link or Razorpay
   */
  async handleWebhook(rawBody: Buffer, signature: string) {
    const webhookSecret = this.configService.get<string>('externalServices.razorpay.webhookSecret');
    if (webhookSecret) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');
      if (expected !== signature) {
        // Log and return 200 — do not throw, otherwise Razorpay retries indefinitely
        this.logger.warn('Razorpay webhook: invalid signature — ignoring');
        return { received: false };
      }
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Razorpay webhook: invalid JSON payload');
      return { received: false };
    }

    this.logger.log(`Razorpay webhook received: ${event.event}`);
    const eventName: string = event.event ?? '';

    try {
      // payment.captured — from createOrder flow (customer app)
      if (eventName === 'payment.captured') {
        const paymentEntity = event.payload?.payment?.entity;
        const orderId: string = paymentEntity?.order_id ?? '';
        const paymentId: string = paymentEntity?.id ?? '';
        const amountRupees = typeof paymentEntity?.amount === 'number' ? paymentEntity.amount / 100 : undefined;
        if (orderId) {
          await this.markPaymentComplete(orderId, paymentId, amountRupees);
        }
      }

      // payment_link.paid — from createPaymentLink flow (rider QR)
      if (eventName === 'payment_link.paid') {
        const linkEntity = event.payload?.payment_link?.entity;
        const paymentEntity = event.payload?.payment?.entity;
        const linkId: string = linkEntity?.id ?? '';
        const paymentId: string = paymentEntity?.id ?? '';
        const bookingId: string = linkEntity?.reference_id ?? '';
        const amountRupees = typeof linkEntity?.amount === 'number' ? linkEntity.amount / 100 : undefined;
        if (linkId) {
          await this.markPaymentComplete(linkId, paymentId, amountRupees, bookingId);
        }
      }
    } catch (err) {
      // Log but still return 200 — Razorpay retries on non-2xx, which can cause duplicates
      // The idempotency check in markPaymentComplete prevents double-recording
      this.logger.error(`Webhook processing error for event ${eventName}: ${err}`);
    }

    return { received: true };
  }

  private async markPaymentComplete(
    razorpayOrderOrLinkId: string,
    razorpayPaymentId: string,
    amount?: number,
    bookingId?: string,
  ) {
    let payment = await this.paymentRepository.findOne({
      where: { razorpay_order_id: razorpayOrderOrLinkId },
    });

    if (payment) {
      if (payment.payment_status === PaymentStatus.COMPLETED) return; // idempotent
      payment.payment_status = PaymentStatus.COMPLETED;
      payment.razorpay_payment_id = razorpayPaymentId;
      payment.transaction_id = razorpayPaymentId;
      if (amount && !payment.amount) payment.amount = amount;
      await this.paymentRepository.save(payment);
      this.logger.log(`Payment marked complete via webhook: ${razorpayPaymentId}`);

      if (payment.booking_id) {
        const booking = await this.bookingRepository.findOne({ where: { id: payment.booking_id } });
        if (booking?.driver_id) {
          this.notificationService.notifyPaymentReceived(
            booking.driver_id,
            Number(payment.amount),
            payment.booking_id,
          ).catch(() => {});
        }
      }
    } else if (bookingId) {
      // Payment link paid but no existing record — create one
      payment = this.paymentRepository.create({
        booking_id: bookingId,
        amount: amount ?? 0,
        payment_method: PaymentMethod.UPI,
        payment_status: PaymentStatus.COMPLETED,
        razorpay_order_id: razorpayOrderOrLinkId,
        razorpay_payment_id: razorpayPaymentId,
        transaction_id: razorpayPaymentId,
      });
      await this.paymentRepository.save(payment);
      this.logger.log(`Payment record created via webhook for booking: ${bookingId}`);
    }
  }

  /**
   * Get payment history
   */
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

    return {
      payments,
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Generate invoice (placeholder)
   */
  async generateInvoice(bookingId: string, userId: string) {
    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['booking', 'booking.customer', 'booking.driver'],
    });

    if (!payment) {
      throw new NotFoundException('Payment not found for this booking');
    }

    if (payment.booking.customer_id !== userId && payment.booking.driver_id !== userId) {
      throw new BadRequestException('You do not have access to this invoice');
    }

    // TODO: Generate actual PDF invoice using pdfkit or similar
    return {
      message: 'Invoice generation coming soon',
      payment_id: payment.id,
      booking_id: bookingId,
      amount: payment.amount,
      status: payment.payment_status,
    };
  }
}
