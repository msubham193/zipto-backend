import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Routes explicitly marked @Public() bypass role checks even when the
    // controller has a class-level @Roles() (e.g. webhooks on AdminController).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    this.logger.log(`Required roles: ${JSON.stringify(requiredRoles)}`);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    this.logger.log(
      `User from request: ${user ? JSON.stringify({ id: user.id, role: user.role }) : 'null'}`,
    );

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    const hasRole = requiredRoles.some((role) => user.role === role);

    this.logger.log(`User role: ${user.role}, hasRole: ${hasRole}`);

    if (!hasRole) {
      throw new ForbiddenException(
        `Requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
