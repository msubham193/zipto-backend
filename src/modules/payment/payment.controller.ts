import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  Res,
  Req,
  Header,
  Headers,
  RawBodyRequest,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { InitiatePaymentDto, CashPaymentDto } from './dto/payment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Payment')
@Controller('payment')
@ApiBearerAuth()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ─── HDFC SmartGateway ────────────────────────────────────────────────────

  @Post('initiate')
  @Roles('customer')
  @ApiOperation({ summary: 'Initiate HDFC payment — returns encRequest for WebView' })
  @ApiResponse({ status: 201, description: 'Payment initiated' })
  async initiatePayment(@GetUser() user: User, @Body() dto: InitiatePaymentDto) {
    return this.paymentService.initiatePayment(user.id, dto);
  }

  /**
   * HDFC posts the encrypted payment result here.
   * Returns HTML that JS-redirects to /payment/hdfc/result so the WebView
   * can detect the URL change and determine success/failure.
   */
  @Post('hdfc/response')
  @Public()
  @Header('Content-Type', 'text/html')
  @ApiOperation({ summary: 'HDFC SmartGateway response webhook (PUBLIC)' })
  async handleHdfcResponse(
    @Body('encResp') encResp: string,
    @Res() res: Response,
  ) {
    const html = await this.paymentService.handleHdfcResponse(encResp ?? '');
    res.send(html);
  }

  /**
   * Final landing page — WebView detects this URL to know payment is done.
   * Returns minimal HTML with status info.
   */
  @Get('hdfc/result')
  @Public()
  @Header('Content-Type', 'text/html')
  @ApiOperation({ summary: 'HDFC payment result page (WebView detection point)' })
  async hdfcResult(
    @Query('status') status: string,
    @Query('orderId') orderId: string,
    @Query('amount') amount: string,
    @Query('ref') ref: string,
    @Res() res: Response,
  ) {
    const isSuccess = status === 'success';
    const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Zipto Payment ${isSuccess ? 'Successful' : 'Failed'}</title>
    <style>
      body { font-family: sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f9fafb; }
      .card { text-align:center; padding:32px; border-radius:16px; background:#fff; box-shadow:0 4px 20px rgba(0,0,0,.08); }
      .icon { font-size:64px; margin-bottom:16px; }
      h2 { margin:0 0 8px; color:${isSuccess ? '#16a34a' : '#dc2626'}; }
      p { color:#6b7280; margin:0; font-size:14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${isSuccess ? '✅' : status === 'cancelled' ? '❌' : '⚠️'}</div>
      <h2>${isSuccess ? 'Payment Successful' : status === 'cancelled' ? 'Payment Cancelled' : 'Payment Failed'}</h2>
      <p>${isSuccess ? `₹${amount} paid successfully` : 'Please go back and try again'}</p>
      ${ref && isSuccess ? `<p style="margin-top:8px;font-size:12px;color:#9ca3af">Ref: ${ref}</p>` : ''}
    </div>
  </body>
</html>`;
    res.send(html);
  }

  // ─── Cashfree PG ──────────────────────────────────────────────────────────

  @Post('create-payment-link')
  @Roles('driver', 'customer')
  @ApiOperation({ summary: 'Create a Cashfree payment link (delivery QR) for a booking' })
  async createPaymentLink(
    @GetUser() user: User,
    @Body('booking_id') bookingId: string,
    @Body('amount') amount: number,
  ) {
    if (!bookingId) throw new BadRequestException('booking_id is required');
    return this.paymentService.createBookingPaymentLink(user.id, bookingId, amount);
  }

  @Post('cashfree/initiate')
  @Roles('customer')
  @ApiOperation({ summary: 'Create a Cashfree order — returns a checkout_url for the WebView' })
  @ApiResponse({ status: 201, description: 'Cashfree order created' })
  async initiateCashfree(@GetUser() user: User, @Body() dto: InitiatePaymentDto) {
    return this.paymentService.initiateCashfree(user.id, dto);
  }

  /** HTML page the app WebView loads to launch the Cashfree checkout. */
  @Get('cashfree/checkout')
  @Public()
  @Header('Content-Type', 'text/html')
  @ApiOperation({ summary: 'Cashfree checkout page (loaded in WebView)' })
  async cashfreeCheckout(@Query('sid') sid: string, @Res() res: Response) {
    res.send(this.paymentService.buildCashfreeCheckoutHtml(sid ?? ''));
  }

  /** Cashfree redirects here after payment — WebView detection point. */
  @Get('cashfree/return')
  @Public()
  @Header('Content-Type', 'text/html')
  @ApiOperation({ summary: 'Cashfree return/result page (WebView detection point)' })
  async cashfreeReturn(@Query('order_id') orderId: string, @Res() res: Response) {
    res.send(await this.paymentService.handleCashfreeReturn(orderId ?? ''));
  }

  @Post('wallet/cashfree/create-order')
  @Roles('customer')
  @ApiOperation({ summary: 'Create a Cashfree order to add money to the customer wallet' })
  async initiateCashfreeWallet(@GetUser() user: User, @Body('amount') amount: number) {
    return this.paymentService.initiateCashfreeWallet(user.id, amount);
  }

  @Post('wallet/cashfree/verify')
  @Roles('customer')
  @ApiOperation({ summary: 'Confirm a Cashfree wallet top-up and credit the wallet (idempotent)' })
  async verifyCashfreeWallet(@GetUser() user: User, @Body('order_id') orderId: string) {
    if (!orderId) throw new BadRequestException('order_id is required');
    return this.paymentService.verifyCashfreeWallet(user.id, orderId);
  }

  /** Cashfree server-to-server webhook (authoritative). */
  @Post('cashfree/webhook')
  @Public()
  @ApiOperation({ summary: 'Cashfree payment webhook (PUBLIC, signature-verified)' })
  async cashfreeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string,
    @Headers('x-webhook-timestamp') timestamp: string,
    @Res() res: Response,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    await this.paymentService.handleCashfreeWebhook(raw, signature, timestamp);
    res.status(200).json({ received: true });
  }

  @Get('status/:bookingId')
  @Roles('customer')
  @ApiOperation({ summary: 'Poll payment status for a booking' })
  async getPaymentStatus(
    @Param('bookingId') bookingId: string,
    @GetUser() user: User,
  ) {
    return this.paymentService.getPaymentStatus(bookingId, user.id);
  }

  // ─── Cash ─────────────────────────────────────────────────────────────────

  @Post('cash')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Record cash payment' })
  @ApiResponse({ status: 201, description: 'Cash payment recorded' })
  async recordCashPayment(@GetUser() user: User, @Body() dto: CashPaymentDto) {
    return this.paymentService.recordCashPayment(user.id, dto);
  }

  // ─── History / Invoice ────────────────────────────────────────────────────

  @Get('history')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Get payment history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.paymentService.getHistory(user.id, page, limit);
  }

  @Get('invoice/:bookingId')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Generate invoice' })
  async generateInvoice(@Param('bookingId') bookingId: string, @GetUser() user: User) {
    return this.paymentService.generateInvoice(bookingId, user.id);
  }
}
