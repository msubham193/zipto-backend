import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
}

@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly keyId: string;
  private readonly keySecret: string;
  private razorpay: any;

  constructor(private configService: ConfigService) {
    this.keyId = this.configService.get<string>('externalServices.razorpay.keyId') || '';
    this.keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') || '';

    // Initialize Razorpay only if credentials are available
    if (this.keyId && this.keySecret) {
      try {
        const Razorpay = require('razorpay');
        this.razorpay = new Razorpay({
          key_id: this.keyId,
          key_secret: this.keySecret,
        });
        this.logger.log('Razorpay initialized successfully');
      } catch (error) {
        this.logger.warn('Razorpay SDK not installed, using mock mode');
      }
    } else {
      this.logger.warn('Razorpay credentials not configured, using mock mode');
    }
  }

  /**
   * Create Razorpay order
   */
  async createOrder(amount: number, receipt: string): Promise<RazorpayOrder> {
    if (!this.razorpay) {
      // Mock order for development
      const mockOrder: RazorpayOrder = {
        id: `order_mock_${Date.now()}`,
        amount: Math.round(amount * 100), // Convert to paise
        currency: 'INR',
        receipt,
      };
      this.logger.log(`Mock Razorpay order created: ${mockOrder.id}`);
      return mockOrder;
    }

    try {
      const order = await this.razorpay.orders.create({
        amount: Math.round(amount * 100), // Convert to paise
        currency: 'INR',
        receipt,
      });

      this.logger.log(`Razorpay order created: ${order.id}`);
      return order;
    } catch (error: any) {
      this.logger.error(`Razorpay order creation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify payment signature
   */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.keySecret) {
      this.logger.warn('Razorpay key secret not configured, skipping verification');
      return true; // Skip verification in mock mode
    }

    const generatedSignature = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const isValid = generatedSignature === signature;

    if (isValid) {
      this.logger.log(`Payment signature verified for order: ${orderId}`);
    } else {
      this.logger.warn(`Invalid payment signature for order: ${orderId}`);
    }

    return isValid;
  }

  /**
   * Fetch payment details
   */
  async getPayment(paymentId: string): Promise<any> {
    if (!this.razorpay) {
      this.logger.warn('Razorpay not initialized');
      return null;
    }

    try {
      const payment = await this.razorpay.payments.fetch(paymentId);
      return payment;
    } catch (error: any) {
      this.logger.error(`Failed to fetch payment: ${error.message}`);
      return null;
    }
  }
}
