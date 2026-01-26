import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CreateOrderDto, VerifyPaymentDto, CashPaymentDto } from './dto/payment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Payment')
@Controller('payment')
@ApiBearerAuth()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create-order')
  @Roles('customer')
  @ApiOperation({ summary: 'Create Razorpay payment order' })
  @ApiResponse({ status: 201, description: 'Order created successfully' })
  async createOrder(@GetUser() user: User, @Body() createOrderDto: CreateOrderDto) {
    return this.paymentService.createOrder(user.id, createOrderDto);
  }

  @Post('verify')
  @Roles('customer')
  @ApiOperation({ summary: 'Verify Razorpay payment' })
  @ApiResponse({ status: 200, description: 'Payment verified successfully' })
  async verifyPayment(@GetUser() user: User, @Body() verifyPaymentDto: VerifyPaymentDto) {
    return this.paymentService.verifyPayment(user.id, verifyPaymentDto);
  }

  @Post('cash')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Record cash payment' })
  @ApiResponse({ status: 201, description: 'Cash payment recorded' })
  async recordCashPayment(@GetUser() user: User, @Body() cashPaymentDto: CashPaymentDto) {
    return this.paymentService.recordCashPayment(user.id, cashPaymentDto);
  }

  @Get('history')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Get payment history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Payment history retrieved' })
  async getHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.paymentService.getHistory(user.id, page, limit);
  }

  @Get('invoice/:bookingId')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Generate and download invoice' })
  @ApiResponse({ status: 200, description: 'Invoice generated' })
  async generateInvoice(@Param('bookingId') bookingId: string, @GetUser() user: User) {
    return this.paymentService.generateInvoice(bookingId, user.id);
  }
}
