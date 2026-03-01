import { Injectable, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private reflector: Reflector) {
    super();
    this.logger.log('JwtAuthGuard instantiated');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      this.logger.log('Route is public, skipping auth');
      return true;
    }

    this.logger.log('=== JwtAuthGuard.canActivate START ===');
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    this.logger.log(`Auth header: ${authHeader ? authHeader.substring(0, 30) + '...' : 'MISSING'}`);

    try {
      const result = await super.canActivate(context);
      this.logger.log(`super.canActivate result: ${result}`);
      return result as boolean;
    } catch (error) {
      this.logger.error(`canActivate error: ${error.message}`);
      throw error;
    }
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    this.logger.log(
      `handleRequest - err: ${err}, user: ${user?.id || 'null'}, info: ${JSON.stringify(info)}`,
    );

    if (err || !user) {
      throw err || new UnauthorizedException(info?.message || 'Invalid or expired token');
    }

    // Attach user to request
    const request = context.switchToHttp().getRequest();
    request.user = user;
    this.logger.log(`User attached to request: ${user.id}`);

    return user;
  }
}
