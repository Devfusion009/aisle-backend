import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { UserRole } from '../interfaces/tenant-context.interface.js';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let configService: ConfigService;
  let reflector: Reflector;

  beforeEach(() => {
    jwtService = {
      verifyAsync: vi.fn(),
    } as any;

    configService = {
      get: vi.fn().mockReturnValue('test-secret'),
    } as any;

    reflector = new Reflector();
    guard = new JwtAuthGuard(jwtService, configService, reflector);
  });

  function createMockContext(
    authHeader?: string,
    isPublic?: boolean,
  ) {
    reflector.getAllAndOverride = (() => isPublic) as any;

    const request: any = {
      headers: {
        authorization: authHeader,
      },
    };

    return {
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as any,
      request,
    };
  }

  it('should allow access for public routes', async () => {
    const { context } = createMockContext(undefined, true);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should throw UnauthorizedException when no token is present', async () => {
    const { context } = createMockContext(undefined, false);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when authorization header is not Bearer', async () => {
    const { context } = createMockContext('Basic abc123', false);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should populate request.user with TenantContext on valid token', async () => {
    const payload = {
      sub: 'user-123',
      tenantId: 'tenant-456',
      email: 'test@example.com',
      role: UserRole.TENANT_OWNER,
      priority: 'high',
    };

    vi.mocked(jwtService.verifyAsync).mockResolvedValue(payload);

    const { context, request } = createMockContext('Bearer valid-token', false);
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toEqual({
      tenantId: 'tenant-456',
      userId: 'user-123',
      email: 'test@example.com',
      role: UserRole.TENANT_OWNER,
      priority: 'high',
    });
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-token', {
      secret: 'test-secret',
    });
  });

  it('should throw UnauthorizedException when token is invalid/expired', async () => {
    vi.mocked(jwtService.verifyAsync).mockRejectedValue(new Error('jwt expired'));

    const { context } = createMockContext('Bearer expired-token', false);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
