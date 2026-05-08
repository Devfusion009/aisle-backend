import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, MIN_ROLE_KEY } from '../decorators/rbac.decorators';
import { UserRole, TenantContext } from '../interfaces/tenant-context.interface';
import { roleAtLeast } from '../rbac/rbac.constants';

/**
 * Role-Based Access Control Guard.
 * Supports two decorator styles:
 *   • @Roles(r1, r2, ...) — exact-set membership
 *   • @MinRole(r)         — hierarchy threshold (user.role >= r)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const exact = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const min = this.reflector.getAllAndOverride<UserRole>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if ((!exact || exact.length === 0) && !min) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const tenantContext = user as TenantContext;

    if (!tenantContext || !tenantContext.role) {
      throw new ForbiddenException('User role not found');
    }

    if (exact && exact.length > 0 && !exact.includes(tenantContext.role)) {
      throw new ForbiddenException(
        `Access denied. Required roles: ${exact.join(', ')}`,
      );
    }

    if (min && !roleAtLeast(tenantContext.role, min)) {
      throw new ForbiddenException(
        `Access denied. Minimum role required: ${min}`,
      );
    }

    return true;
  }
}
