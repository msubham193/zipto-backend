import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum OTPPurpose {
  REGISTRATION = 'registration',
  LOGIN = 'login',
  FORGOT_PASSWORD = 'forgot_password',
}

@Entity('otps')
export class OTP {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 15 })
  @Index()
  phone: string;

  @Column({ type: 'varchar', length: 6 })
  otp_code: string;

  @Column({
    type: 'enum',
    enum: OTPPurpose,
  })
  purpose: OTPPurpose;

  @Column({ type: 'boolean', default: false })
  is_used: boolean;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
