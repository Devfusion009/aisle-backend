import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { UserRole } from '../interfaces/tenant-context.interface.js';
import { ROLES_KEY, MIN_ROLE_KEY } from '../decorators/rbac.decorators.js';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(
    user: any,
    meta: { roles?: UserRole[]; minRole?: UserRole } = {},
  ) {
    // Return metadata based on which key the guard asks for
    reflector.getAllAndOverride = ((key: string) => {
      if (key === ROLES_KEY) return meta.roles;
      if (key === MIN_ROLE_KEY) return meta.minRole;
      return undefined;
    }) as any;

    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as any;
  }

  it('should allow access when no roles are specified', () => {
    const context = createMockContext({}, {});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when roles array is empty', () => {
    const context = createMockContext({}, { roles: [] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when user has a matching role', () => {
    const user = { tenantId: 't1', userId: 'u1', role: UserRole.TENANT_OWNER, email: 'a@b.com' };
    const context = createMockContext(user, {
      roles: [UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException when user does not have a matching role', () => {
    const user = { tenantId: 't1', userId: 'u1', role: UserRole.USER, email: 'a@b.com' };
    const context = createMockContext(user, { roles: [UserRole.TENANT_OWNER] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when user context is missing role', () => {
    const context = createMockContext({}, { roles: [UserRole.TENANT_OWNER] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when user context is null', () => {
    const context = createMockContext(null, { roles: [UserRole.TENANT_OWNER] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow access when minRole threshold is satisfied', () => {
    const user = { tenantId: 't1', userId: 'u1', role: UserRole.TENANT_OWNER, email: 'a@b.com' };
    const context = createMockContext(user, { minRole: UserRole.TENANT_ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException when minRole threshold is not met', () => {
    const user = { tenantId: 't1', userId: 'u1', role: UserRole.EDITOR, email: 'a@b.com' };
    const context = createMockContext(user, { minRole: UserRole.TENANT_ADMIN });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
