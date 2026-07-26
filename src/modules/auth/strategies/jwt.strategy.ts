import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
    });
  }

  async validate(payload: any): Promise<User> {
    const { sub: userId } = payload;

    // Deleted accounts are marked is_active=false, so this also rejects them.
    const user = await this.userRepository.findOne({
      where: { id: userId, is_active: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Single-session enforcement for drivers: a login on a new device rotates
    // active_session_id, so any token minted for an earlier device carries a
    // stale `sid` and is rejected here — signing that device out immediately.
    // Skipped when active_session_id is null (pre-existing sessions) so this
    // never force-logs-out everyone the moment it ships.
    if (
      user.role === UserRole.DRIVER &&
      user.active_session_id &&
      payload.sid !== user.active_session_id
    ) {
      throw new UnauthorizedException({
        message: 'You have been signed out because your account was used on another device.',
        code: 'SESSION_REVOKED',
      });
    }

    return user;
  }
}
