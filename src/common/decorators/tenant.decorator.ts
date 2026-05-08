import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TenantContext } from '../interfaces/tenant-context.interface';

/**
 * Parameter decorator to inject the resolved TenantContext into controller methods.
 * 
 * Usage:
 * ```typescript
 * @Get()
 * findAll(@Tenant() tenant: TenantContext) {
 *   // tenant.tenantId, tenant.userId, tenant.role available
 * }
 * ```
 */
export const Tenant = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext): TenantContext | string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as TenantContext;

    // If a specific property is requested, return just that
    if (data) {
      return user[data];
    }

    return user;
  },
);

/**
 * Shorthand decorator to get just the tenant ID
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.tenantId;
  },
);

/**
 * Shorthand decorator to get just the user ID
 */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.userId;
  },
);
