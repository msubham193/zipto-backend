import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoinTransaction, CoinTransactionType } from './entities/coin-transaction.entity';
import { User } from '../auth/entities/user.entity';
import { ServiceCategory } from '../booking/entities/booking.entity';
import { getPaginationMeta } from '../../common/utils/helpers.util';

@Injectable()
export class CoinService {
  private readonly logger = new Logger(CoinService.name);

  // 100 coins = ₹2
  static readonly COINS_TO_RUPEES_RATE = 2 / 100; // 0.02 per coin
  static readonly MIN_COINS_PER_DELIVERY = 5;

  constructor(
    @InjectRepository(CoinTransaction)
    private coinTransactionRepository: Repository<CoinTransaction>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  /**
   * Calculate coins reward based on distance and order amount
   *
   * Formula:
   *   base_coins = (distance_km * 2) + (order_amount / 10)
   *
   * Multipliers (stacked):
   *   - Distance > 20km: 1.5x | Distance > 10km: 1.25x
   *   - Amount > ₹1000: 1.5x | Amount > ₹500: 1.25x
   *   - Service category: medicine=1.3x, food=1.2x, packages=1.1x, goods=1.0x
   *
   * Minimum: 5 coins per delivery
   */
  calculateRewardCoins(
    distanceKm: number,
    orderAmount: number,
    serviceCategory: ServiceCategory,
  ): { coins: number; multiplier: number } {
    // Base coins: 2 coins per km + 1 coin per ₹10 spent
    const distanceCoins = distanceKm * 2;
    const amountCoins = orderAmount / 10;
    const baseCoins = distanceCoins + amountCoins;

    // Distance multiplier
    let distanceMultiplier = 1.0;
    if (distanceKm > 20) {
      distanceMultiplier = 1.5;
    } else if (distanceKm > 10) {
      distanceMultiplier = 1.25;
    }

    // Amount multiplier
    let amountMultiplier = 1.0;
    if (orderAmount > 1000) {
      amountMultiplier = 1.5;
    } else if (orderAmount > 500) {
      amountMultiplier = 1.25;
    }

    // Service category multiplier (essential services get bonus)
    let categoryMultiplier = 1.0;
    switch (serviceCategory) {
      case ServiceCategory.MEDICINE:
        categoryMultiplier = 1.3;
        break;
      case ServiceCategory.FOOD_DELIVERY:
        categoryMultiplier = 1.2;
        break;
      case ServiceCategory.SEND_PACKAGES:
        categoryMultiplier = 1.1;
        break;
      case ServiceCategory.TRANSPORT_GOODS:
        categoryMultiplier = 1.0;
        break;
    }

    const totalMultiplier = distanceMultiplier * amountMultiplier * categoryMultiplier;
    let finalCoins = Math.round(baseCoins * totalMultiplier);

    // Minimum coins guarantee
    if (finalCoins < CoinService.MIN_COINS_PER_DELIVERY) {
      finalCoins = CoinService.MIN_COINS_PER_DELIVERY;
    }

    return {
      coins: finalCoins,
      multiplier: Math.round(totalMultiplier * 100) / 100,
    };
  }

  /**
   * Award coins to user after successful delivery
   */
  async awardCoins(
    userId: string,
    bookingId: string,
    distanceKm: number,
    orderAmount: number,
    serviceCategory: ServiceCategory,
  ): Promise<CoinTransaction> {
    const { coins, multiplier } = this.calculateRewardCoins(
      distanceKm,
      orderAmount,
      serviceCategory,
    );

    // Create transaction record
    const transaction = this.coinTransactionRepository.create({
      user_id: userId,
      coins,
      type: CoinTransactionType.EARNED,
      booking_id: bookingId,
      description: `Earned ${coins} coins for delivery (${distanceKm}km, ₹${orderAmount})`,
      distance_km: distanceKm,
      order_amount: orderAmount,
      multiplier,
    });

    await this.coinTransactionRepository.save(transaction);

    // Update user's total coins
    await this.userRepository.increment({ id: userId }, 'coins', coins);

    this.logger.log(
      `Awarded ${coins} coins to user ${userId} for booking ${bookingId} (multiplier: ${multiplier}x)`,
    );

    return transaction;
  }

  /**
   * Credit a fixed number of coins to a user (e.g. referral bonus, promo).
   * Records a transaction and atomically increments the balance. Reuses the
   * EARNED type — the description distinguishes the source for reporting.
   */
  async creditCoins(
    userId: string,
    coins: number,
    description: string,
    bookingId?: string,
  ): Promise<CoinTransaction> {
    const transaction = this.coinTransactionRepository.create({
      user_id: userId,
      coins,
      type: CoinTransactionType.EARNED,
      booking_id: bookingId ?? undefined,
      description,
      multiplier: 1,
    });

    await this.coinTransactionRepository.save(transaction);
    await this.userRepository.increment({ id: userId }, 'coins', coins);

    this.logger.log(`Credited ${coins} coins to user ${userId} — ${description}`);
    return transaction;
  }

  /**
   * Get user's coin balance
   */
  async getBalance(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'coins', 'wallet_balance'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      coins: user.coins,
      rupee_value: Math.round(user.coins * CoinService.COINS_TO_RUPEES_RATE * 100) / 100,
      wallet_balance: Number(user.wallet_balance),
      rate: '100 coins = ₹2',
      min_transfer: 100,
    };
  }

  /**
   * Get coin transaction history
   */
  async getHistory(userId: string, page: number = 1, limit: number = 10) {
    const [transactions, total] = await this.coinTransactionRepository.findAndCount({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      transactions,
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Transfer coins to wallet balance (min 100 coins)
   * 100 coins = ₹2
   */
  async transferToWallet(userId: string, coins: number): Promise<{ coins_deducted: number; rupees_added: number; new_coin_balance: number; new_wallet_balance: number }> {
    if (coins < 100) {
      throw new BadRequestException('Minimum 100 coins required to transfer to wallet');
    }

    const validCoins = Math.floor(coins / 100) * 100;
    if (validCoins === 0) {
      throw new BadRequestException('Minimum 100 coins required to transfer to wallet');
    }

    const rupeesAdded = Math.round(validCoins * CoinService.COINS_TO_RUPEES_RATE * 100) / 100;

    // Atomic check-and-update: deduct coins AND add wallet balance only if sufficient coins exist
    const rows: { coins: number; wallet_balance: string }[] = await this.userRepository.manager.query(
      `UPDATE users SET coins = coins - $1, wallet_balance = wallet_balance + $2
       WHERE id = $3 AND coins >= $1
       RETURNING coins, wallet_balance`,
      [validCoins, rupeesAdded, userId],
    );

    if (!rows.length) {
      const exists = await this.userRepository.count({ where: { id: userId } });
      if (!exists) throw new NotFoundException('User not found');
      throw new BadRequestException('Insufficient coins');
    }

    const transaction = this.coinTransactionRepository.create({
      user_id: userId,
      coins: validCoins,
      type: CoinTransactionType.REDEEMED,
      description: `Transferred ${validCoins} coins to wallet (₹${rupeesAdded})`,
      multiplier: 1,
    });
    await this.coinTransactionRepository.save(transaction);

    this.logger.log(`User ${userId} transferred ${validCoins} coins → ₹${rupeesAdded} wallet`);

    return {
      coins_deducted: validCoins,
      rupees_added: rupeesAdded,
      new_coin_balance: rows[0].coins,
      new_wallet_balance: Number(rows[0].wallet_balance),
    };
  }

  /**
   * Redeem coins (deduct from balance)
   */
  async redeemCoins(userId: string, coins: number, description: string): Promise<CoinTransaction> {
    // Atomic check-and-deduct to prevent race conditions
    const rows: { id: string }[] = await this.userRepository.manager.query(
      `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING id`,
      [coins, userId],
    );

    if (!rows.length) {
      const exists = await this.userRepository.count({ where: { id: userId } });
      if (!exists) throw new NotFoundException('User not found');
      throw new BadRequestException('Insufficient coins');
    }

    const transaction = this.coinTransactionRepository.create({
      user_id: userId,
      coins,
      type: CoinTransactionType.REDEEMED,
      description,
      multiplier: 1,
    });

    await this.coinTransactionRepository.save(transaction);

    this.logger.log(`Redeemed ${coins} coins for user ${userId}`);

    return transaction;
  }
}
