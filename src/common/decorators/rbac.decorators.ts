import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../interfaces/tenant-context.interface';
import { Permission } from '../rbac/rbac.constants';

export const ROLES_KEY = 'rbac:roles';
export const MIN_ROLE_KEY = 'rbac:minRole';
export const PERM_KEY = 'rbac:permissions';
export const KB_ACCESS_KEY = 'rbac:kbAccess';

/** Must be at-or-above this role in the hierarchy. */
export const MinRole = (role: UserRole) => SetMetadata(MIN_ROLE_KEY, role);

/** Must hold ALL these permissions. */
export const RequirePermission = (...perms: Permission[]) =>
  SetMetadata(PERM_KEY, perms);

export interface KbAccessOptions {
  /** Where to read the dataset id from on the request. */
  source: 'param' | 'query' | 'body';
  /** Key inside that source (default 'datasetId'). */
  key?: string;
  /** Skip the check if no id is present (list endpoints). */
  optional?: boolean;
}

/** Gate endpoints that operate on a specific dataset. */
export const KbAccess = (opts: KbAccessOptions) =>
  SetMetadata(KB_ACCESS_KEY, opts);
