import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
  ) {
    const secret = configService.get<string>('jwt.secret');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
    this.logger.log(`JwtStrategy initialized with secret: ${secret?.substring(0, 10)}...`);
  }

  async validate(payload: any): Promise<User> {
    this.logger.log(`Validating JWT payload: ${JSON.stringify(payload)}`);
    const { sub: userId } = payload;

    const user = await this.userRepository.findOne({
      where: { id: userId, is_active: true },
    });

    if (!user) {
      this.logger.error(`User not found for id: ${userId}`);
      throw new UnauthorizedException('User not found or inactive');
    }

    this.logger.log(`User validated: ${user.id}`);
    return user;
  }
}
