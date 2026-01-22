import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Payment, PaymentMethod, PaymentStatus } from './entities/payment.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { CreateOrderDto, VerifyPaymentDto, CashPaymentDto } from './dto/payment.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import * as crypto from 'crypto';

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
    const { booking_id, amount } = createOrderDto;

    // Verify booking belongs to user and is completed
    const booking = await this.bookingRepository.findOne({
      where: { id: booking_id },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customer_id !== userId) {
      throw new BadRequestException('You do not have access to this booking');
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException('Can only create payment for completed bookings');
    }

    // Check if payment already exists
    const existingPayment = await this.paymentRepository.findOne({
      where: { booking_id },
    });

    if (existingPayment && existingPayment.payment_status === PaymentStatus.COMPLETED) {
      throw new BadRequestException('Payment already completed for this booking');
    }

    // For now, return mock order (Razorpay integration commented out)
    // TODO: Integrate actual Razorpay SDK when API keys are available
    /*
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: this.configService.get('externalServices.razorpay.keyId'),
      key_secret: this.configService.get('externalServices.razorpay.keySecret'),
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      receipt: `receipt_${booking_id}`,
    });
    */

    const mockOrderId = `order_${Date.now()}`;

    // Create payment record
    const payment = this.paymentRepository.create({
      booking_id,
      amount,
      payment_method: PaymentMethod.UPI,
      payment_status: PaymentStatus.PENDING,
      razorpay_order_id: mockOrderId,
    });

    await this.paymentRepository.save(payment);

    return {
      order_id: mockOrderId,
      amount,
      currency: 'INR',
    };
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

    // Verify signature (mock verification for now)
    // TODO: Implement actual Razorpay signature verification
    /*
    const razorpayKeySecret = this.configService.get('externalServices.razorpay.keySecret');
    const generatedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      throw new BadRequestException('Invalid payment signature');
    }
    */

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
