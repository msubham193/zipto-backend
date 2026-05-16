import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ZiptoShieldLedger } from './entities/zipto-shield-ledger.entity';
import { ZiptoShieldTransaction, ShieldTransactionType } from './entities/zipto-shield-transaction.entity';

const LEDGER_ID = 'zipto-shield';
const SHIELD_CONTRIBUTION_PER_BOOKING = 1; // ₹1

@Injectable()
export class ZiptoShieldService {
  private readonly logger = new Logger(ZiptoShieldService.name);

  constructor(
    @InjectRepository(ZiptoShieldLedger)
    private ledgerRepository: Repository<ZiptoShieldLedger>,
    @InjectRepository(ZiptoShieldTransaction)
    private transactionRepository: Repository<ZiptoShieldTransaction>,
    private dataSource: DataSource,
  ) {}

  private async getOrCreateLedger(): Promise<ZiptoShieldLedger> {
    let ledger = await this.ledgerRepository.findOne({ where: { id: LEDGER_ID } });
    if (!ledger) {
      ledger = this.ledgerRepository.create({
        id: LEDGER_ID,
        balance: 0,
        total_contributed: 0,
        total_withdrawn: 0,
      });
      await this.ledgerRepository.save(ledger);
    }
    return ledger;
  }

  /**
   * Called on every completed booking — idempotent via booking_id check.
   */
  async contribute(bookingId: string): Promise<void> {
    const existing = await this.transactionRepository.findOne({
      where: {
        booking_id: bookingId,
        type: ShieldTransactionType.CONTRIBUTION,
      },
    });
    if (existing) return; // already contributed for this booking

    await this.dataSource.transaction(async (manager) => {
      const ledgerRepo = manager.getRepository(ZiptoShieldLedger);
      const txRepo = manager.getRepository(ZiptoShieldTransaction);

      const ledger = await ledgerRepo.findOne({ where: { id: LEDGER_ID } });
      const current = ledger ?? ledgerRepo.create({ id: LEDGER_ID, balance: 0, total_contributed: 0, total_withdrawn: 0 });

      const amount = SHIELD_CONTRIBUTION_PER_BOOKING;
      current.balance = Number(current.balance) + amount;
      current.total_contributed = Number(current.total_contributed) + amount;
      await ledgerRepo.save(current);

      await txRepo.save(txRepo.create({
        type: ShieldTransactionType.CONTRIBUTION,
        amount,
        balance_after: current.balance,
        booking_id: bookingId,
      }));
    });

    this.logger.log(`[ZiptoShield] ₹${SHIELD_CONTRIBUTION_PER_BOOKING} contributed for booking=${bookingId}`);
  }

  /**
   * Admin withdraws from the shield fund.
   */
  async withdraw(adminId: string, amount: number, notes?: string): Promise<{ balance: number }> {
    if (amount <= 0) throw new BadRequestException('Withdrawal amount must be greater than 0');

    let newBalance: number;

    await this.dataSource.transaction(async (manager) => {
      const ledgerRepo = manager.getRepository(ZiptoShieldLedger);
      const txRepo = manager.getRepository(ZiptoShieldTransaction);

      const ledger = await ledgerRepo.findOne({ where: { id: LEDGER_ID } });
      if (!ledger) throw new NotFoundException('Shield fund not initialised yet');

      const currentBalance = Number(ledger.balance);
      if (amount > currentBalance) {
        throw new BadRequestException(
          `Insufficient shield balance. Available: ₹${currentBalance.toFixed(2)}`,
        );
      }

      ledger.balance = currentBalance - amount;
      ledger.total_withdrawn = Number(ledger.total_withdrawn) + amount;
      await ledgerRepo.save(ledger);

      await txRepo.save(txRepo.create({
        type: ShieldTransactionType.WITHDRAWAL,
        amount,
        balance_after: ledger.balance,
        withdrawn_by: adminId,
        notes: notes ?? null,
      }));

      newBalance = ledger.balance;
    });

    this.logger.warn(`[ZiptoShield] ₹${amount} withdrawn by admin=${adminId}`);
    return { balance: newBalance };
  }

  async getBalance(): Promise<ZiptoShieldLedger> {
    return this.getOrCreateLedger();
  }

  async getTransactions(query: {
    type?: ShieldTransactionType;
    page?: number;
    limit?: number;
  }) {
    const { type, page = 1, limit = 30 } = query;

    const qb = this.transactionRepository
      .createQueryBuilder('t')
      .orderBy('t.created_at', 'DESC')
      .take(limit)
      .skip((page - 1) * limit);

    if (type) qb.where('t.type = :type', { type });

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pages: Math.ceil(total / limit) };
  }
}