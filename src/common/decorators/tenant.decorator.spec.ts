import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';

// Capture each factory function before createParamDecorator wraps it
const capturedFactories: Array<(data: any, ctx: any) => any> = [];

vi.mock('@nestjs/common', async () => {
  const actual = await vi.importActual<any>('@nestjs/common');
  return {
    ...actual,
    createParamDecorator: vi.fn((factory: (data: any, ctx: any) => any) => {
      capturedFactories.push(factory);
      return factory; // return as-is so tests can invoke it directly
    }),
  };
});

// Import after mock is registered — this triggers the three createParamDecorator calls
await import('./tenant.decorator.js');

// Factories are captured in file declaration order: Tenant [0], TenantId [1], UserId [2]

function mockCtx(user: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

const mockUser = {
  tenantId: 'tenant-123',
  userId: 'user-456',
  email: 'admin@example.com',
  role: 'tenant_owner',
};

describe('Tenant decorator', () => {
  const factory = () => capturedFactories[0];

  it('returns the full user context when no data key is provided', () => {
    expect(factory()(undefined, mockCtx(mockUser))).toEqual(mockUser);
  });

  it('returns a specific field when a data key is provided', () => {
    expect(factory()('tenantId', mockCtx(mockUser))).toBe('tenant-123');
  });
});

describe('TenantId decorator', () => {
  it('returns tenantId from request.user', () => {
    const factory = capturedFactories[1];
    expect(factory(undefined, mockCtx(mockUser))).toBe('tenant-123');
  });
});

describe('UserId decorator', () => {
  it('returns userId from request.user', () => {
    const factory = capturedFactories[2];
    expect(factory(undefined, mockCtx(mockUser))).toBe('user-456');
  });
});
