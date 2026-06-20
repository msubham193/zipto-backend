import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserRole } from '../auth/entities/user.entity';
import { EmailService } from '../../services/email.service';
import { ChangePasswordDto, CreateAdminDto } from './dto/admin-account.dto';

const BCRYPT_ROUNDS = 10;

/**
 * Admin account management: self-service password change (email-OTP verified),
 * and super-admin-only team management (invite admins, enable/disable, reset
 * passwords). Also seeds the root super-admin on boot.
 */
@Injectable()
export class AdminAccountService implements OnModuleInit {
  private readonly logger = new Logger(AdminAccountService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Boot seeding ───────────────────────────────────────────────────────────

  async onModuleInit() {
    try {
      await this.seedSuperAdmin();
      await this.retireLegacyAdmins();
    } catch (err: any) {
      this.logger.error(`Admin seeding failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Disable legacy/default admin logins (e.g. admin@skido.com) so only the
   * configured super-admin and admins created through the panel can sign in.
   * Idempotent and never touches the super-admin row.
   */
  private async retireLegacyAdmins() {
    const emails = (this.configService.get<string[]>('externalServices.admin.legacyAdminEmails') || [])
      .filter((e) => e && e !== this.superAdminEmail);
    if (!emails.length) return;

    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ is_active: false, refresh_token: null as any })
      .where('lower(email) IN (:...emails)', { emails })
      .andWhere('role = :role', { role: UserRole.ADMIN })
      .andWhere('is_super_admin = false')
      .andWhere('is_active = true')
      .execute();

    if (result.affected) {
      this.logger.warn(`Retired ${result.affected} legacy admin login(s): ${emails.join(', ')}`);
    }
  }

  private get superAdminEmail(): string {
    return (this.configService.get<string>('externalServices.admin.superAdminEmail')
      || 'ashwini@ridezipto.com').trim().toLowerCase();
  }

  /**
   * Ensure the configured root super-admin exists. Idempotent: creates it with
   * the seed password if missing, otherwise just promotes it to super-admin
   * (never overwrites an existing password so later changes persist).
   */
  private async seedSuperAdmin() {
    const email = this.superAdminEmail;
    const existing = await this.userRepository.findOne({ where: { email } });

    if (existing) {
      const patch: Partial<User> = {};
      if (existing.role !== UserRole.ADMIN) patch.role = UserRole.ADMIN;
      if (!existing.is_super_admin) patch.is_super_admin = true;
      if (!existing.is_active) patch.is_active = true;
      if (!existing.is_verified) patch.is_verified = true;
      if (Object.keys(patch).length) {
        await this.userRepository.update(existing.id, patch);
        this.logger.log(`Super-admin ${this.mask(email)} reconciled (${Object.keys(patch).join(', ')})`);
      }
      return;
    }

    const password = this.configService.get<string>('externalServices.admin.superAdminPassword') || 'Admin@123';
    const name = this.configService.get<string>('externalServices.admin.superAdminName') || 'Ashwini';
    const user = this.userRepository.create({
      email,
      name,
      role: UserRole.ADMIN,
      password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      is_super_admin: true,
      is_active: true,
      is_verified: true,
      must_change_password: false,
    });
    await this.userRepository.save(user);
    this.logger.warn(`Seeded root super-admin ${this.mask(email)} (set SUPER_ADMIN_PASSWORD / rotate after first login)`);
  }

  // ─── Self-service password change (email-OTP) ─────────────────────────────────

  /** Step 1 — email a verification code to the admin's own address. */
  async requestPasswordChangeOtp(actor: User) {
    if (!actor.email) {
      throw new BadRequestException('Your account has no email address on file.');
    }
    await this.emailService.sendOtp(actor.email, actor.name || 'Admin', 'password_change');
    return {
      message: 'A verification code has been sent to your email.',
      email: this.mask(actor.email),
    };
  }

  /** Step 2 — verify current password + OTP, then set the new password. */
  async changePassword(actorId: string, dto: ChangePasswordDto) {
    const user = await this.userRepository.findOne({ where: { id: actorId } });
    if (!user) throw new NotFoundException('Account not found');
    if (!user.email) throw new BadRequestException('Your account has no email address on file.');

    if (!user.password_hash || !(await bcrypt.compare(dto.currentPassword, user.password_hash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const otpOk = await this.emailService.verifyOtp(user.email, 'password_change', dto.otp);
    if (!otpOk) throw new BadRequestException('Invalid verification code');

    if (await bcrypt.compare(dto.newPassword, user.password_hash)) {
      throw new BadRequestException('New password must be different from the current password');
    }

    await this.userRepository.update(user.id, {
      password_hash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS),
      must_change_password: false,
      // Invalidate other sessions' refresh tokens after a credential change.
      refresh_token: null as any,
    });

    this.logger.log(`Password changed for admin ${this.mask(user.email)}`);
    return { message: 'Password changed successfully' };
  }

  // ─── Super-admin: team management ─────────────────────────────────────────────

  private assertSuperAdmin(actor: User) {
    const isSuper = actor.is_super_admin || actor.email?.toLowerCase() === this.superAdminEmail;
    if (!isSuper) {
      throw new ForbiddenException('Only the super-admin can manage the admin team.');
    }
  }

  async listAdmins(actor: User) {
    this.assertSuperAdmin(actor);
    const admins = await this.userRepository.find({
      where: { role: UserRole.ADMIN },
      order: { is_super_admin: 'DESC', created_at: 'ASC' },
    });
    return admins.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      is_super_admin: a.is_super_admin,
      is_active: a.is_active,
      must_change_password: a.must_change_password,
      created_at: a.created_at,
    }));
  }

  /** Invite a new admin: create the account + email a temporary password. */
  async createAdmin(actor: User, dto: CreateAdminDto) {
    this.assertSuperAdmin(actor);

    const email = dto.email.trim().toLowerCase();
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const tempPassword = this.generateTempPassword();
    const user = this.userRepository.create({
      email,
      name: dto.name.trim(),
      role: UserRole.ADMIN,
      password_hash: await bcrypt.hash(tempPassword, BCRYPT_ROUNDS),
      is_super_admin: false,
      is_active: true,
      is_verified: true,
      must_change_password: true,
    });
    await this.userRepository.save(user);

    // Deliver credentials. If email delivery fails, roll back so the super-admin
    // can retry with a working address (otherwise the admin can never log in).
    try {
      await this.emailService.sendAdminInvite(email, user.name, tempPassword, actor.name || 'A super-admin');
    } catch (err) {
      await this.userRepository.delete(user.id);
      throw err;
    }

    this.logger.log(`Admin ${this.mask(email)} created by ${this.mask(actor.email)}`);
    return {
      message: `Admin created. A temporary password was emailed to ${email}.`,
      admin: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_active: user.is_active,
        must_change_password: user.must_change_password,
        created_at: user.created_at,
      },
    };
  }

  async setAdminStatus(actor: User, targetId: string, isActive: boolean) {
    this.assertSuperAdmin(actor);
    const target = await this.findManageableAdmin(actor, targetId);
    if (target.is_super_admin) {
      throw new ForbiddenException('The super-admin account cannot be disabled.');
    }
    await this.userRepository.update(target.id, {
      is_active: isActive,
      ...(isActive ? {} : { refresh_token: null as any }),
    });
    return { message: isActive ? 'Admin enabled' : 'Admin disabled' };
  }

  /** Super-admin resets a colleague's password and re-emails a temp one. */
  async resetAdminPassword(actor: User, targetId: string) {
    this.assertSuperAdmin(actor);
    const target = await this.findManageableAdmin(actor, targetId);
    if (!target.email) throw new BadRequestException('That admin has no email address on file.');

    const tempPassword = this.generateTempPassword();
    await this.userRepository.update(target.id, {
      password_hash: await bcrypt.hash(tempPassword, BCRYPT_ROUNDS),
      must_change_password: true,
      refresh_token: null as any,
    });
    await this.emailService.sendAdminInvite(target.email, target.name, tempPassword, actor.name || 'A super-admin');

    this.logger.log(`Password reset for admin ${this.mask(target.email)} by ${this.mask(actor.email)}`);
    return { message: `A new temporary password was emailed to ${target.email}.` };
  }

  private async findManageableAdmin(actor: User, targetId: string): Promise<User> {
    if (targetId === actor.id) {
      throw new BadRequestException('Use the password change screen to manage your own account.');
    }
    const target = await this.userRepository.findOne({
      where: { id: targetId, role: UserRole.ADMIN },
    });
    if (!target) throw new NotFoundException('Admin not found');
    return target;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** 12-char password guaranteed to satisfy the policy (letters + digits). */
  private generateTempPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const all = upper + lower + digits;
    const pick = (set: string) => set[crypto.randomInt(set.length)];
    const chars = [pick(upper), pick(lower), pick(digits), pick(digits)];
    while (chars.length < 12) chars.push(pick(all));
    // Fisher–Yates shuffle so the guaranteed chars aren't always in front.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  private mask(email?: string | null): string {
    if (!email) return '(none)';
    const [u, d] = email.split('@');
    if (!d) return email;
    const head = u.length <= 2 ? u[0] || '' : u.slice(0, 2);
    return `${head}***@${d}`;
  }
}
