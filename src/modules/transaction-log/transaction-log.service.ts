import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { TransactionLog } from './entities/transaction-log.entity';
import { getPaginationMeta } from '../../common/utils/helpers.util';

export interface RecordTxnInput {
  category: string;
  direction: 'credit' | 'debit';
  amount: number;
  userId?: string | null;
  counterpartyUserId?: string | null;
  unit?: 'INR' | 'COIN';
  status?: 'pending' | 'success' | 'failed';
  gateway?: 'cashfree' | 'razorpayx' | 'hdfc' | 'wallet' | 'cash' | 'internal' | null;
  gatewayRef?: string | null;
  bookingId?: string | null;
  balanceAfter?: number | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class TransactionLogService {
  private readonly logger = new Logger(TransactionLogService.name);

  constructor(
    @InjectRepository(TransactionLog)
    private readonly repo: Repository<TransactionLog>,
  ) {}

  /**
   * Append a transaction entry. Never throws — logging must never break the
   * money flow it records. Fire-and-forget friendly.
   */
  async record(input: RecordTxnInput): Promise<void> {
    try {
      const entry = this.repo.create({
        user_id: input.userId ?? null,
        counterparty_user_id: input.counterpartyUserId ?? null,
        category: input.category,
        direction: input.direction,
        amount: Number(input.amount) || 0,
        unit: input.unit ?? 'INR',
        status: input.status ?? 'success',
        gateway: input.gateway ?? null,
        gateway_ref: input.gatewayRef ?? null,
        booking_id: input.bookingId ?? null,
        balance_after: input.balanceAfter ?? null,
        description: input.description ?? null,
        metadata: input.metadata ?? null,
      });
      await this.repo.save(entry);
    } catch (err: any) {
      this.logger.warn(`[txn-log] failed to record ${input.category}: ${err?.message}`);
    }
  }

  /** Admin: paginated + filterable transaction list. */
  async adminList(params: {
    userId?: string;
    category?: string;
    gateway?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));

    const where: any = {};
    if (params.userId) where.user_id = params.userId;
    if (params.category && params.category !== 'all') where.category = params.category;
    if (params.gateway && params.gateway !== 'all') where.gateway = params.gateway;
    if (params.status && params.status !== 'all') where.status = params.status;
    if (params.from && params.to) {
      where.created_at = Between(new Date(params.from), new Date(`${params.to}T23:59:59.999Z`));
    }

    const [items, total] = await this.repo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { transactions: items, ...getPaginationMeta(total, page, limit) };
  }

  /** Admin: quick totals for a date range / filter. */
  async adminSummary(params: { from?: string; to?: string }) {
    const qb = this.repo
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('t.direction', 'direction')
      .addSelect('t.unit', 'unit')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(t.amount),0)', 'total')
      .where("t.status = 'success'")
      .groupBy('t.category')
      .addGroupBy('t.direction')
      .addGroupBy('t.unit');

    if (params.from && params.to) {
      qb.andWhere('t.created_at BETWEEN :from AND :to', {
        from: new Date(params.from),
        to: new Date(`${params.to}T23:59:59.999Z`),
      });
    }

    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      category: r.category,
      direction: r.direction,
      unit: r.unit,
      count: Number(r.count) || 0,
      total: Number(r.total) || 0,
    }));
  }
}
