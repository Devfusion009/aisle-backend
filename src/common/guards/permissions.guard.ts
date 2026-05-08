import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERM_KEY } from '../decorators/rbac.decorators';
import { Permission, roleHas } from '../rbac/rbac.constants';
import { TenantContext } from '../interfaces/tenant-context.interface';

/**
 * PermissionsGuard — checks @RequirePermission(...) metadata against the caller's
 * role-derived permission set. Resource-scoped permissions (e.g. per-dataset KB access)
 * belong in KbPermissionGuard, not here.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const tenantContext = user as TenantContext;

    if (!tenantContext || !tenantContext.role) {
      throw new ForbiddenException('Not authenticated');
    }

    const missing = required.filter((p) => !roleHas(tenantContext.role, p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Access denied. Missing permission(s): ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
