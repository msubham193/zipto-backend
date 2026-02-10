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
import { CreateOrderDto, VerifyPaymentDto, CashPaymentDto } from './dto/payment.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
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
  ) {}

  /**
   * Create Razorpay order
   */
  async createOrder(userId: string, createOrderDto: CreateOrderDto) {
    try {
      const { booking_id, amount } = createOrderDto;
      this.logger.log(
        `createOrder called - booking_id: ${booking_id}, amount: ${amount}, userId: ${userId}`,
      );

      const booking = await this.bookingRepository.findOne({
        where: { id: booking_id },
      });

      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      this.logger.log(
        `Booking found - status: ${booking.status}, customer_id: ${booking.customer_id}`,
      );

      if (booking.customer_id !== userId) {
        throw new BadRequestException('You do not have access to this booking');
      }

      if (booking.status === BookingStatus.CANCELLED) {
        throw new BadRequestException('Cannot create payment for cancelled bookings');
      }

      // Check if payment already exists and is completed
      const existingPayment = await this.paymentRepository.findOne({
        where: { booking_id },
      });

      if (existingPayment && existingPayment.payment_status === PaymentStatus.COMPLETED) {
        throw new BadRequestException('Payment already completed for this booking');
      }

      // If a pending payment order already exists, return it
      if (
        existingPayment &&
        existingPayment.payment_status === PaymentStatus.PENDING &&
        existingPayment.razorpay_order_id
      ) {
        return {
          order_id: existingPayment.razorpay_order_id,
          amount: existingPayment.amount,
          currency: 'INR',
          key: this.configService.get('externalServices.razorpay.keyId'),
        };
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

      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency: 'INR',
        receipt: `receipt_${booking_id}`,
      });

      this.logger.log(`Razorpay order created: ${order.id}`);

      // Create payment record
      const payment = this.paymentRepository.create({
        booking_id,
        amount,
        payment_method: PaymentMethod.UPI,
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
      const err = error as Error;
      this.logger.error(`createOrder error: ${err?.message || error}`, err?.stack);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException(err?.message || 'Failed to create payment order');
    }
  }

  /**
   * Verify Razorpay payment
   */
  async verifyPayment(userId: string, verifyPaymentDto: VerifyPaymentDto) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_id } =
      verifyPaymentDto;

    // Find payment record
    const payment = await this.paymentRepository.findOne({
      where: { booking_id, razorpay_order_id },
      relations: ['booking'],
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.booking.customer_id !== userId) {
      throw new BadRequestException('You do not have access to this payment');
    }

    // Verify Razorpay signature
    const razorpayKeySecret = this.configService.get<string>('externalServices.razorpay.keySecret');
    if (!razorpayKeySecret) {
      throw new BadRequestException('Razorpay key secret is not configured');
    }
    const generatedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      payment.payment_status = PaymentStatus.FAILED;
      await this.paymentRepository.save(payment);
      throw new BadRequestException('Invalid payment signature');
    }

    // Update payment record
    payment.payment_status = PaymentStatus.COMPLETED;
    payment.razorpay_payment_id = razorpay_payment_id;
    payment.razorpay_signature = razorpay_signature;
    payment.transaction_id = razorpay_payment_id;

    await this.paymentRepository.save(payment);

    this.logger.log(`Payment completed for booking: ${booking_id}`);

    return {
      payment,
      booking: payment.booking,
    };
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

    return payment;
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
