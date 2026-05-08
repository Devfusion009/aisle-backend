import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KB_ACCESS_KEY, KbAccessOptions } from '../decorators/rbac.decorators';
import { UserRole, TenantContext } from '../interfaces/tenant-context.interface';
import { Permission, roleHas } from '../rbac/rbac.constants';
import { KbPermissionService } from '../../modules/knowledge/kb-permission.service';

/**
 * KbPermissionGuard — enforces the resource-scoped rule:
 *   - Any role that already holds KB_READ (admin/owner/editor) passes.
 *   - A regular USER must have priority='high' AND an explicit grant
 *     in user_dataset_access for the targeted datasetId.
 *
 * Activated only on endpoints decorated with @KbAccess(...).
 */
@Injectable()
export class KbPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly kb: KbPermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<KbAccessOptions>(KB_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!opts) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as TenantContext | undefined;
    if (!user) throw new ForbiddenException('Not authenticated');

    // Fast path: admin/owner/editor already hold KB_READ globally.
    if (roleHas(user.role, Permission.KB_READ)) return true;

    // Only regular users reach here.
    if (user.role !== UserRole.USER) {
      throw new ForbiddenException('Knowledge base access denied');
    }

    if (user.priority !== 'high') {
      throw new ForbiddenException(
        'Knowledge base access is limited to high-priority users',
      );
    }

    const key = opts.key ?? 'datasetId';
    const datasetId: string | undefined =
      opts.source === 'param'
        ? request.params?.[key]
        : opts.source === 'query'
          ? request.query?.[key]
          : request.body?.[key];

    if (!datasetId) {
      if (opts.optional) return true;
      throw new BadRequestException(`Missing ${key}`);
    }

    const ok = await this.kb.userHasAccess(user.userId, user.tenantId, datasetId);
    if (!ok) {
      throw new ForbiddenException('You do not have access to this dataset');
    }
    return true;
  }
}
