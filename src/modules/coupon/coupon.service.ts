import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Coupon, CouponType } from './entities/coupon.entity';
import { CouponUsage } from './entities/coupon-usage.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { CreateCouponDto, UpdateCouponDto, ValidateCouponDto } from './dto/coupon.dto';

export interface CouponValidationResult {
  coupon_id: string;
  code: string;
  title: string;
  type: CouponType;
  discount_amount: number; // ₹ off applied to the given order_value
  final_fare: number;      // order_value - discount_amount
}

@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);

  constructor(
    @InjectRepository(Coupon)
    private couponRepository: Repository<Coupon>,
    @InjectRepository(CouponUsage)
    private usageRepository: Repository<CouponUsage>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private dataSource: DataSource,
  ) {}

  // ─── Admin CRUD ────────────────────────────────────────────────────────────

  async create(dto: CreateCouponDto): Promise<Coupon> {
    const code = dto.code.toUpperCase().trim();
    const existing = await this.couponRepository.findOne({ where: { code } });
    if (existing) throw new ConflictException(`Coupon code "${code}" already exists`);

    const coupon = this.couponRepository.create({
      ...dto,
      code,
      valid_from:  new Date(dto.valid_from),
      valid_until: dto.valid_until ? new Date(dto.valid_until) : undefined,
    } as any);
    return this.couponRepository.save(coupon as any) as Promise<Coupon>;
  }

  async findAll(includeInactive = false): Promise<Coupon[]> {
    const where = includeInactive ? {} : { is_active: true };
    return this.couponRepository.find({ where, order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({ where: { id } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return coupon;
  }

  async update(id: string, dto: UpdateCouponDto): Promise<Coupon> {
    const coupon = await this.findOne(id);
    const updates: any = { ...dto };
    if (dto.valid_from)  updates.valid_from  = new Date(dto.valid_from);
    if (dto.valid_until) updates.valid_until = new Date(dto.valid_until);
    Object.assign(coupon, updates);
    return this.couponRepository.save(coupon);
  }

  async remove(id: string): Promise<{ message: string }> {
    const coupon = await this.findOne(id);
    await this.couponRepository.remove(coupon);
    return { message: 'Coupon deleted' };
  }

  async getUsageStats(id: string) {
    const coupon = await this.findOne(id);
    const usages = await this.usageRepository.find({
      where: { coupon_id: id },
      order: { used_at: 'DESC' },
      take: 50,
    });
    return { coupon, usages };
  }

  // ─── Customer-facing list of usable coupons ───────────────────────────────

  /**
   * Returns coupons the customer can currently see in the "View All Coupons"
   * sheet: active, within the validity window, not over the global usage cap,
   * and (if a vehicle type is given) applicable to it.
   *
   * Per-user usage / first-ride rules are intentionally NOT filtered here —
   * the coupon still shows, and validate() gives a precise reason if the user
   * can't actually apply it. This keeps the list informative.
   */
  async listAvailable(vehicleType?: string): Promise<Coupon[]> {
    const now = new Date();
    const coupons = await this.couponRepository.find({
      where: { is_active: true },
      order: { value: 'DESC', created_at: 'DESC' },
    });

    const vt = vehicleType?.trim().toLowerCase();
    const result = coupons.filter((c) => {
      if (now < new Date(c.valid_from)) {
        this.logger.warn(`[coupons] "${c.code}" hidden: valid_from ${c.valid_from} is in the future (now=${now.toISOString()})`);
        return false;
      }
      if (c.valid_until && now > new Date(c.valid_until)) {
        this.logger.warn(`[coupons] "${c.code}" hidden: expired (valid_until ${c.valid_until})`);
        return false;
      }
      if (c.max_uses_total !== null && c.used_count >= c.max_uses_total) {
        this.logger.warn(`[coupons] "${c.code}" hidden: usage limit reached`);
        return false;
      }
      if (vt && c.applicable_vehicle_types?.length) {
        // Case-insensitive match — admin may enter "Bike" while the app sends "bike".
        const allowed = c.applicable_vehicle_types.map((t) => String(t).trim().toLowerCase());
        if (!allowed.includes(vt)) {
          this.logger.warn(`[coupons] "${c.code}" hidden: vehicle "${vt}" not in [${allowed.join(', ')}]`);
          return false;
        }
      }
      return true;
    });
    this.logger.log(`[coupons] vehicleType=${vehicleType ?? 'none'} | active in DB=${coupons.length} | returned=${result.length}`);
    return result;
  }

  // ─── Customer validation (called before booking is confirmed) ─────────────

  async validate(userId: string, dto: ValidateCouponDto): Promise<CouponValidationResult> {
    return this._validateInternal(userId, dto);
  }

  // ─── Internal validation used by booking service ──────────────────────────

  async _validateInternal(
    userId: string,
    dto: { code: string; order_value: number; vehicle_type?: string },
  ): Promise<CouponValidationResult> {
    const code = dto.code.toUpperCase().trim();
    const coupon = await this.couponRepository.findOne({ where: { code } });

    if (!coupon || !coupon.is_active) {
      throw new BadRequestException(`Coupon "${code}" is invalid or has been deactivated`);
    }

    const now = new Date();
    if (now < coupon.valid_from) {
      throw new BadRequestException('This coupon is not yet active');
    }
    if (coupon.valid_until && now > coupon.valid_until) {
      throw new BadRequestException('This coupon has expired');
    }

    if (dto.order_value < Number(coupon.min_order_value)) {
      throw new BadRequestException(
        `Minimum order value of ₹${coupon.min_order_value} required for this coupon`,
      );
    }

    if (coupon.applicable_vehicle_types?.length && dto.vehicle_type) {
      if (!coupon.applicable_vehicle_types.includes(dto.vehicle_type)) {
        throw new BadRequestException(
          `Coupon not valid for ${dto.vehicle_type}. Valid for: ${coupon.applicable_vehicle_types.join(', ')}`,
        );
      }
    }

    if (coupon.max_uses_total !== null && coupon.used_count >= coupon.max_uses_total) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }

    const userUsageCount = await this.usageRepository.count({
      where: { coupon_id: coupon.id, user_id: userId },
    });
    if (userUsageCount >= coupon.max_uses_per_user) {
      throw new BadRequestException(
        `You have already used this coupon ${coupon.max_uses_per_user > 1 ? coupon.max_uses_per_user + ' times' : ''}`.trim(),
      );
    }

    if (coupon.is_first_ride_only) {
      const priorBookings = await this.bookingRepository.count({
        where: { customer_id: userId, status: BookingStatus.COMPLETED },
      });
      if (priorBookings > 0) {
        throw new BadRequestException('This coupon is only valid for your first ride');
      }
    }

    const discount = this._calcDiscount(coupon, dto.order_value);

    return {
      coupon_id:       coupon.id,
      code:            coupon.code,
      title:           coupon.title,
      type:            coupon.type,
      discount_amount: discount,
      final_fare:      Math.max(0, Math.round(dto.order_value - discount)),
    };
  }

  private _calcDiscount(coupon: Coupon, orderValue: number): number {
    switch (coupon.type) {
      case CouponType.FLAT:
        return Math.min(Number(coupon.value), orderValue);

      case CouponType.PERCENTAGE: {
        const pct = (Number(coupon.value) / 100) * orderValue;
        const capped = coupon.max_discount ? Math.min(pct, Number(coupon.max_discount)) : pct;
        return Math.round(Math.min(capped, orderValue));
      }

      case CouponType.FREE_DELIVERY:
        return orderValue; // full discount
    }
  }

  /**
   * Record coupon use atomically.
   * Uses a DB transaction with row-level lock to prevent over-use under concurrency.
   */
  async recordUsage(
    couponId: string,
    userId: string,
    bookingId: string,
    discountApplied: number,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const coupon = await manager
        .createQueryBuilder(Coupon, 'c')
        .setLock('pessimistic_write')
        .where('c.id = :id', { id: couponId })
        .getOne();

      if (!coupon) throw new NotFoundException('Coupon not found during booking');

      if (coupon.max_uses_total !== null && coupon.used_count >= coupon.max_uses_total) {
        throw new BadRequestException('Coupon usage limit reached');
      }

      coupon.used_count += 1;
      await manager.save(Coupon, coupon);

      const usage = manager.create(CouponUsage, {
        coupon_id:        couponId,
        user_id:          userId,
        booking_id:       bookingId,
        discount_applied: discountApplied,
      });
      await manager.save(CouponUsage, usage);
    });
  }
}
