import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThanOrEqual } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomerReport, ReportType, ReportSeverity } from './entities/customer-report.entity';
import { UserBlock, BlockStatus, UnblockRequestStatus } from './entities/user-block.entity';
import { User } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { NotificationService } from '../notification/notification.service';
import { BlockCustomerDto, ProcessUnblockDto, ReportCustomerDto, ReportReason, SubmitUnblockRequestDto } from './dto/fraud.dto';

@Injectable()
export class FraudService implements OnModuleInit {
  private notificationService: NotificationService;

  constructor(
    @InjectRepository(CustomerReport)
    private reportRepository: Repository<CustomerReport>,
    @InjectRepository(UserBlock)
    private blockRepository: Repository<UserBlock>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    this.notificationService = this.moduleRef.get(NotificationService, { strict: false });
  }

  /**
   * Called after every booking cancellation (fire-and-forget)
   */
  async runFraudChecks(customerId: string, bookingId: string): Promise<void> {
    try {
      await Promise.all([
        this.checkPostAcceptCancellation(customerId, bookingId),
        this.checkCancellationRate(customerId, bookingId),
        this.checkRapidBookingPattern(customerId, bookingId),
      ]);
    } catch (err) {
      // Never block the caller
    }
  }

  /**
   * Rule 1: Post-acceptance cancellations (>= 3 in 7 days)
   */
  private async checkPostAcceptCancellation(customerId: string, bookingId: string): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const count = await this.bookingRepository
      .createQueryBuilder('b')
      .where('b.customer_id = :customerId', { customerId })
      .andWhere('b.status = :status', { status: BookingStatus.CANCELLED })
      .andWhere('b.acceptance_time IS NOT NULL')
      .andWhere('b.updated_at >= :since', { since: sevenDaysAgo })
      .getCount();

    if (count < 3) return;

    // Deduplicate: skip if unresolved report of same type already exists
    const existing = await this.reportRepository.findOne({
      where: { customer_id: customerId, report_type: ReportType.AUTO_POST_ACCEPT_CANCEL, is_resolved: false },
    });
    if (existing) return;

    const severity = count >= 5 ? ReportSeverity.HIGH : ReportSeverity.MEDIUM;
    await this.createAutoReport(customerId, bookingId, ReportType.AUTO_POST_ACCEPT_CANCEL, severity,
      `${count} cancellations after driver acceptance within last 7 days`, { count, window_days: 7 });
  }

  /**
   * Rule 2: High cancellation rate (>= 50% over 30 days, min 5 bookings)
   */
  private async checkCancellationRate(customerId: string, bookingId: string): Promise<void> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const total = await this.bookingRepository.count({
      where: { customer_id: customerId, created_at: MoreThan(thirtyDaysAgo) },
    });

    if (total < 5) return;

    const cancelled = await this.bookingRepository.count({
      where: { customer_id: customerId, status: BookingStatus.CANCELLED, updated_at: MoreThan(thirtyDaysAgo) },
    });

    const rate = cancelled / total;
    if (rate < 0.5) return;

    const existing = await this.reportRepository.findOne({
      where: { customer_id: customerId, report_type: ReportType.AUTO_CANCELLATION_RATE, is_resolved: false },
    });
    if (existing) return;

    const severity = rate >= 0.7 ? ReportSeverity.HIGH : ReportSeverity.MEDIUM;
    const ratePercent = Math.round(rate * 100);
    await this.createAutoReport(customerId, bookingId, ReportType.AUTO_CANCELLATION_RATE, severity,
      `High cancellation rate: ${ratePercent}% over last 30 days (${cancelled}/${total} bookings)`,
      { cancelled, total, rate: ratePercent, window_days: 30 });
  }

  /**
   * Rule 3: Rapid booking+cancel pattern (>= 4 in 60 minutes)
   */
  private async checkRapidBookingPattern(customerId: string, bookingId: string): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const count = await this.bookingRepository
      .createQueryBuilder('b')
      .where('b.customer_id = :customerId', { customerId })
      .andWhere('b.status = :status', { status: BookingStatus.CANCELLED })
      .andWhere('b.created_at >= :since', { since: oneHourAgo })
      .getCount();

    if (count < 4) return;

    const existing = await this.reportRepository.findOne({
      where: { customer_id: customerId, report_type: ReportType.AUTO_RAPID_BOOKING, is_resolved: false },
    });
    if (existing) return;

    await this.createAutoReport(customerId, bookingId, ReportType.AUTO_RAPID_BOOKING, ReportSeverity.LOW,
      `${count} rapid booking-cancellation cycles within 60 minutes`, { count, window_minutes: 60 });
  }

  private async createAutoReport(
    customerId: string,
    bookingId: string,
    reportType: ReportType,
    severity: ReportSeverity,
    reason: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    const report = this.reportRepository.create({
      customer_id: customerId,
      booking_id: bookingId,
      report_type: reportType,
      reason,
      severity,
      metadata,
    });
    await this.reportRepository.save(report);

    // Notify admin
    const customer = await this.userRepository.findOne({ where: { id: customerId }, select: ['name', 'phone'] });
    await this.notificationService.notifyAdminFraudFlag(
      customerId,
      customer?.name || 'Unknown',
      reportType,
      severity,
    );
  }

  /**
   * Driver manual report
   */
  async reportCustomer(driverUserId: string, dto: ReportCustomerDto): Promise<CustomerReport> {
    const booking = await this.bookingRepository.findOne({
      where: { id: dto.booking_id, driver_id: driverUserId },
    });
    if (!booking) throw new NotFoundException('Booking not found or not assigned to you');

    // Only allow reporting on cancelled bookings
    if (booking.status !== BookingStatus.CANCELLED) {
      throw new BadRequestException('You can only report a customer after a cancellation');
    }

    // Count existing unresolved driver reports on this customer to escalate severity
    const existingCount = await this.reportRepository.count({
      where: {
        customer_id: booking.customer_id,
        report_type: ReportType.DRIVER_REPORT,
        is_resolved: false,
      },
    });

    const severity = existingCount >= 2 ? ReportSeverity.HIGH : ReportSeverity.MEDIUM;
    const reasonText = dto.description
      ? `${dto.reason}: ${dto.description}`
      : dto.reason;

    const report = this.reportRepository.create({
      customer_id: booking.customer_id,
      reported_by: driverUserId,
      booking_id: dto.booking_id,
      report_type: ReportType.DRIVER_REPORT,
      reason: reasonText,
      severity,
    });

    const saved = await this.reportRepository.save(report);

    const customer = await this.userRepository.findOne({ where: { id: booking.customer_id }, select: ['name', 'phone'] });
    await this.notificationService.notifyAdminFraudFlag(
      booking.customer_id,
      customer?.name || 'Unknown',
      ReportType.DRIVER_REPORT,
      severity,
    );

    return saved;
  }

  /**
   * Admin: Get all reports (paginated + filtered)
   */
  async getReports(query: { page?: number; limit?: number; severity?: string; report_type?: string; customer_id?: string; is_resolved?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const qb = this.reportRepository
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.customer', 'customer')
      .leftJoinAndSelect('report.reporter', 'reporter')
      .orderBy('report.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.severity) qb.andWhere('report.severity = :severity', { severity: query.severity });
    if (query.report_type) qb.andWhere('report.report_type = :report_type', { report_type: query.report_type });
    if (query.customer_id) qb.andWhere('report.customer_id = :customer_id', { customer_id: query.customer_id });
    if (query.is_resolved !== undefined) {
      qb.andWhere('report.is_resolved = :is_resolved', { is_resolved: query.is_resolved === 'true' });
    }

    const [reports, total] = await qb.getManyAndCount();
    return { reports, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Admin: Resolve a report
   */
  async resolveReport(reportId: string, adminId: string): Promise<CustomerReport> {
    const report = await this.reportRepository.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    report.is_resolved = true;
    report.resolved_by = adminId;
    report.resolved_at = new Date();
    return this.reportRepository.save(report);
  }

  /**
   * Admin: Block a customer temporarily
   */
  async blockCustomer(adminId: string, customerId: string, dto: BlockCustomerDto): Promise<UserBlock> {
    const customer = await this.userRepository.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found');

    // Expire any existing active block
    await this.blockRepository.update(
      { customer_id: customerId, status: BlockStatus.ACTIVE },
      { status: BlockStatus.LIFTED, lifted_by: adminId, lifted_at: new Date() },
    );

    const blockedUntil = new Date(Date.now() + dto.duration_days * 24 * 60 * 60 * 1000);

    const block = this.blockRepository.create({
      customer_id: customerId,
      blocked_by: adminId,
      reason: dto.reason,
      duration_days: dto.duration_days,
      blocked_until: blockedUntil,
      status: BlockStatus.ACTIVE,
    });

    const saved = await this.blockRepository.save(block);

    // Deactivate the user account
    await this.userRepository.update(customerId, { is_active: false });

    await this.notificationService.notifyCustomerBlocked(customerId, dto.reason, blockedUntil);

    return saved;
  }

  /**
   * Admin: Immediately unblock a customer
   */
  async unblockCustomer(adminId: string, customerId: string): Promise<void> {
    const activeBlock = await this.blockRepository.findOne({
      where: { customer_id: customerId, status: BlockStatus.ACTIVE },
    });

    if (activeBlock) {
      activeBlock.status = BlockStatus.LIFTED;
      activeBlock.lifted_by = adminId;
      activeBlock.lifted_at = new Date();
      await this.blockRepository.save(activeBlock);
    }

    await this.userRepository.update(customerId, { is_active: true });
    await this.notificationService.notifyCustomerUnblocked(customerId);
  }

  /**
   * Customer: Submit unblock request
   */
  async submitUnblockRequest(customerId: string, dto: SubmitUnblockRequestDto): Promise<UserBlock> {
    const block = await this.blockRepository.findOne({
      where: { customer_id: customerId, status: BlockStatus.ACTIVE },
    });
    if (!block) throw new BadRequestException('No active block found');
    if (block.unblock_request_status === UnblockRequestStatus.PENDING) {
      throw new BadRequestException('An unblock request is already pending');
    }

    block.unblock_request_reason = dto.reason;
    block.unblock_request_at = new Date();
    block.unblock_request_status = UnblockRequestStatus.PENDING;
    return this.blockRepository.save(block);
  }

  /**
   * Admin: Get pending unblock requests
   */
  async getUnblockRequests(query: { page?: number; limit?: number; status?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const qb = this.blockRepository
      .createQueryBuilder('block')
      .leftJoinAndSelect('block.customer', 'customer')
      .orderBy('block.unblock_request_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const status = query.status || 'pending';
    if (status === 'pending') {
      qb.where('block.unblock_request_status = :s', { s: UnblockRequestStatus.PENDING });
    } else {
      qb.where('block.unblock_request_status != :s', { s: UnblockRequestStatus.NONE });
    }

    const [requests, total] = await qb.getManyAndCount();
    return { requests, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Admin: Approve or reject unblock request
   */
  async processUnblockRequest(blockId: string, adminId: string, dto: ProcessUnblockDto): Promise<UserBlock> {
    const block = await this.blockRepository.findOne({ where: { id: blockId } });
    if (!block) throw new NotFoundException('Block record not found');
    if (block.unblock_request_status !== UnblockRequestStatus.PENDING) {
      throw new BadRequestException('No pending unblock request on this block');
    }

    block.unblock_request_status = dto.status === 'approved' ? UnblockRequestStatus.APPROVED : UnblockRequestStatus.REJECTED;
    if (dto.admin_notes) block.admin_notes = dto.admin_notes;

    if (dto.status === 'approved') {
      block.status = BlockStatus.LIFTED;
      block.lifted_by = adminId;
      block.lifted_at = new Date();
      await this.userRepository.update(block.customer_id, { is_active: true });
      await this.notificationService.notifyCustomerUnblocked(block.customer_id);
    }

    return this.blockRepository.save(block);
  }

  /**
   * Get block history for a customer
   */
  async getBlockHistory(customerId: string) {
    return this.blockRepository.find({
      where: { customer_id: customerId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Get active block for a customer (null if not blocked)
   */
  async getActiveBlock(customerId: string): Promise<UserBlock | null> {
    return this.blockRepository.findOne({
      where: { customer_id: customerId, status: BlockStatus.ACTIVE },
    });
  }

  /**
   * Cron: Auto-expire blocks every hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async autoUnblockExpiredBlocks(): Promise<void> {
    const expiredBlocks = await this.blockRepository.find({
      where: {
        status: BlockStatus.ACTIVE,
        blocked_until: LessThanOrEqual(new Date()),
      },
    });

    for (const block of expiredBlocks) {
      block.status = BlockStatus.EXPIRED;
      await this.blockRepository.save(block);
      await this.userRepository.update(block.customer_id, { is_active: true });
      await this.notificationService.notifyCustomerUnblocked(block.customer_id);
    }
  }
}
