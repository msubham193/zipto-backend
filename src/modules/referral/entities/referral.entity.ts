import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum ReferralStatus {
  /** Code applied by the referee — waiting for their first completed ride. */
  PENDING = 'pending',
  /** First ride completed — both parties have been credited their coins. */
  REWARDED = 'rewarded',
  /** Voided (e.g. fraud / manual reversal). */
  CANCELLED = 'cancelled',
}

@Entity('referrals')
@Index(['referrer_id'])
@Index(['status'])
export class Referral {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The existing user who shared their code. */
  @Column({ type: 'uuid' })
  referrer_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referrer_id' })
  referrer: User;

  /** The new user who signed up with the code — one referral per referee. */
  @Column({ type: 'uuid', unique: true })
  referee_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referee_id' })
  referee: User;

  /** The referrer's code that was used (snapshot, for auditing). */
  @Column({ type: 'varchar', length: 12 })
  @Index()
  code: string;

  @Column({ type: 'enum', enum: ReferralStatus, default: ReferralStatus.PENDING })
  status: ReferralStatus;

  /** Referee's device install id at apply-time — used for anti-abuse checks. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  @Index()
  device_id: string | null;

  /** Coins credited to the referee (new user) on qualification. */
  @Column({ type: 'integer', default: 0 })
  referee_coins: number;

  /** Coins credited to the referrer on qualification. */
  @Column({ type: 'integer', default: 0 })
  referrer_coins: number;

  /** The first completed booking that triggered the reward. */
  @Column({ type: 'uuid', nullable: true })
  qualifying_booking_id: string | null;

  @Column({ type: 'timestamp', nullable: true })
  rewarded_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
