import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../interfaces/tenant-context.interface';
import { ROLES_KEY } from './rbac.decorators';

export { ROLES_KEY };

/**
 * Must be one of these exact roles. Backwards-compatible with existing usages.
 * For hierarchy semantics prefer `@MinRole`.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
