import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../../common/interfaces/tenant-context.interface.js';

// Mock the password utility module at the top level (ESM-compatible)
vi.mock('../../common/utils/password.util.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('$2b$12$mocked-hash'),
  verifyPassword: vi.fn().mockResolvedValue(true),
  PASSWORD_REGEX: /./,
  PASSWORD_VALIDATION_MESSAGE: 'mocked',
  BCRYPT_ROUNDS: 12,
}));

// Must import AFTER vi.mock is declared
const { AuthService } = await import('./auth.service.js');
const { verifyPassword } = await import('../../common/utils/password.util.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockUser(overrides: Partial<any> = {}) {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: '$2b$12$hashedpassword',
    role: UserRole.TENANT_OWNER,
    priority: 'low',
    isActive: true,
    lastLoginAt: null,
    profilePhotoUrl: null,
    ...overrides,
  };
}

function createMockTenant(overrides: Partial<any> = {}) {
  return {
    id: 'tenant-1',
    name: 'Test Org',
    slug: 'test-org',
    plan: 'starter',
    settings: {},
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: InstanceType<typeof AuthService>;
  let userRepo: any;
  let tenantRepo: any;
  let jwtService: any;
  let configService: any;
  let dataSource: any;

  beforeEach(() => {
    // Reset mock return values
    vi.mocked(verifyPassword).mockResolvedValue(true);

    userRepo = {
      findOne: vi.fn(),
      save: vi.fn(),
    };

    tenantRepo = {
      findOne: vi.fn(),
    };

    jwtService = {
      signAsync: vi.fn().mockResolvedValue('mock-token'),
      verifyAsync: vi.fn(),
    };

    configService = {
      get: vi.fn().mockReturnValue('1d'),
    };

    dataSource = {
      transaction: vi.fn(),
    };

    service = new AuthService(
      userRepo,
      tenantRepo,
      jwtService,
      configService,
      dataSource,
    );
  });

  // ── login ──────────────────────────────────────────────────────────────

  describe('login()', () => {
    it('should return auth response on successful login (no tenantSlug)', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();

      userRepo.findOne.mockResolvedValue(user);
      tenantRepo.findOne.mockResolvedValue(tenant);
      userRepo.save.mockResolvedValue(user);

      const result = await service.login({
        email: 'test@example.com',
        password: 'Test@1234',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.tenantId).toBe('tenant-1');
    });

    it('should return auth response on successful login (with tenantSlug)', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();

      tenantRepo.findOne.mockResolvedValue(tenant);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockResolvedValue(user);

      const result = await service.login({
        email: 'test@example.com',
        password: 'Test@1234',
        tenantSlug: 'test-org',
      });

      expect(result.user.email).toBe('test@example.com');
    });

    it('should throw UnauthorizedException when user is not found', async () => {
      userRepo.findOne.mockResolvedValue(null);
      tenantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@x.com', password: 'P@ssw0rd' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when password is wrong', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();
      userRepo.findOne.mockResolvedValue(user);
      tenantRepo.findOne.mockResolvedValue(tenant);

      vi.mocked(verifyPassword).mockResolvedValue(false);

      await expect(
        service.login({ email: 'test@example.com', password: 'WrongP@ss0' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when user account is disabled', async () => {
      const user = createMockUser({ isActive: false });
      const tenant = createMockTenant();

      userRepo.findOne.mockResolvedValue(user);
      tenantRepo.findOne.mockResolvedValue(tenant);

      const result = service.login({ email: 'test@example.com', password: 'Test@1234' });

      await expect(result).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when tenant slug does not exist', async () => {
      tenantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'test@example.com',
          password: 'Test@1234',
          tenantSlug: 'nonexistent',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── register ───────────────────────────────────────────────────────────

  describe('register()', () => {
    function makeTxManager() {
      return {
        findOne: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockImplementation((_Class: any, data: any) => ({ id: 'created-id', ...data })),
        save: vi.fn().mockImplementation((entity: any) => Promise.resolve(entity)),
      };
    }

    it('should create a new tenant and return auth response with TENANT_OWNER role', async () => {
      const txManager = makeTxManager();
      txManager.findOne
        .mockResolvedValueOnce(null)  // no tenant slug conflict
        .mockResolvedValueOnce(null); // no duplicate user
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      const result = await service.register({
        email: 'owner@example.com',
        password: 'Test@1234',
        name: 'Owner',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result.user.email).toBe('owner@example.com');
      expect(result.user.role).toBe(UserRole.TENANT_OWNER);
    });

    it('should use provided tenantName when creating new tenant', async () => {
      const txManager = makeTxManager();
      txManager.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await service.register({
        email: 'owner@example.com',
        password: 'Test@1234',
        name: 'Owner',
        tenantName: 'Custom Corp',
      });

      const tenantCreateArgs = txManager.create.mock.calls[0][1];
      expect(tenantCreateArgs.name).toBe('Custom Corp');
    });

    it('should join an existing tenant and create user with USER role', async () => {
      const existingTenant = createMockTenant();
      const txManager = makeTxManager();
      txManager.findOne
        .mockResolvedValueOnce(existingTenant)  // tenant found inside tx
        .mockResolvedValueOnce(null);            // no duplicate user
      tenantRepo.findOne.mockResolvedValue(existingTenant);
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      const result = await service.register({
        email: 'joiner@example.com',
        password: 'Test@1234',
        name: 'Joiner',
        tenantSlug: 'test-org',
      });

      expect(result.user.email).toBe('joiner@example.com');
      expect(result.user.role).toBe(UserRole.USER);
    });

    it('should throw NotFoundException when tenantSlug is not found during pre-validation', async () => {
      tenantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.register({
          email: 'x@x.com',
          password: 'Test@1234',
          name: 'X',
          tenantSlug: 'nonexistent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when tenant disappears inside transaction (race condition)', async () => {
      const txManager = makeTxManager();
      txManager.findOne.mockResolvedValueOnce(null); // tenant gone inside tx
      tenantRepo.findOne.mockResolvedValue(createMockTenant());
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await expect(
        service.register({
          email: 'x@x.com',
          password: 'Test@1234',
          name: 'X',
          tenantSlug: 'test-org',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when email already exists', async () => {
      tenantRepo.findOne.mockResolvedValue(createMockTenant());
      userRepo.findOne.mockResolvedValue(createMockUser());

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'Test@1234',
          name: 'Test',
          tenantSlug: 'test-org',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when duplicate user is detected inside transaction', async () => {
      const txManager = makeTxManager();
      txManager.findOne
        .mockResolvedValueOnce(null)           // no slug conflict
        .mockResolvedValueOnce(createMockUser()); // race-condition duplicate
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'Test@1234',
          name: 'Test',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ForbiddenException when tenant plan user limit is reached', async () => {
      const tenant = createMockTenant({ plan: 'starter' }); // maxUsers = 5
      const txManager = makeTxManager();
      txManager.findOne.mockResolvedValueOnce(tenant);
      txManager.count.mockResolvedValue(5); // at the limit

      tenantRepo.findOne.mockResolvedValue(tenant);
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await expect(
        service.register({
          email: 'extra@example.com',
          password: 'Test@1234',
          name: 'Extra',
          tenantSlug: 'test-org',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ConflictException when generated tenant slug already exists', async () => {
      const txManager = makeTxManager();
      txManager.findOne.mockResolvedValueOnce(createMockTenant()); // slug conflict
      userRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await expect(
        service.register({
          email: 'new@example.com',
          password: 'Test@1234',
          name: 'New',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── refreshToken ───────────────────────────────────────────────────────

  describe('refreshToken()', () => {
    it('should return a new auth response for a valid refresh token', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();

      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: UserRole.TENANT_OWNER,
      });
      userRepo.findOne.mockResolvedValue(user);
      tenantRepo.findOne.mockResolvedValue(tenant);

      const result = await service.refreshToken({ refreshToken: 'valid-refresh' });

      expect(result).toHaveProperty('accessToken');
      expect(result.user.email).toBe('test@example.com');
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('invalid'));

      await expect(
        service.refreshToken({ refreshToken: 'bad-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when user is inactive', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        tenantId: 'tenant-1',
      });
      userRepo.findOne.mockResolvedValue(createMockUser({ isActive: false }));

      await expect(
        service.refreshToken({ refreshToken: 'refresh-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when user not found', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-999',
        tenantId: 'tenant-1',
      });
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.refreshToken({ refreshToken: 'refresh-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when tenant is not found', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        tenantId: 'tenant-1',
      });
      userRepo.findOne.mockResolvedValue(createMockUser());
      tenantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.refreshToken({ refreshToken: 'valid-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
