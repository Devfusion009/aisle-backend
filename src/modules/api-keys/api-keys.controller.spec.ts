import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface.js';

describe('ApiKeysController', () => {
  let controller: ApiKeysController;
  let service: Partial<ApiKeysService>;

  const mockTenant: TenantContext = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'admin@example.com',
    role: UserRole.TENANT_OWNER,
  };

  const mockKeyResponse = {
    id: 'key-1',
    name: 'Test Key',
    description: null,
    keyPrefix: 'vrs_live_1234...',
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: null,
    authorizedAssistantIds: [],
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    service = {
      create: vi.fn().mockResolvedValue({ ...mockKeyResponse, fullKey: 'vrs_live_full' }),
      findAll: vi.fn().mockResolvedValue([mockKeyResponse]),
      revoke: vi.fn().mockResolvedValue({ ...mockKeyResponse, isActive: false }),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    controller = new ApiKeysController(service as ApiKeysService);
  });

  describe('create()', () => {
    it('should delegate to service.create with tenant and dto', async () => {
      const dto = { name: 'New', provider: 'openai', model: 'gpt-4o-mini' };
      const result = await controller.create(mockTenant, dto as any);

      expect(service.create).toHaveBeenCalledWith(mockTenant, dto);
      expect(result.fullKey).toBe('vrs_live_full');
    });
  });

  describe('findAll()', () => {
    it('should delegate to service.findAll with tenant', async () => {
      const result = await controller.findAll(mockTenant);

      expect(service.findAll).toHaveBeenCalledWith(mockTenant);
      expect(result).toHaveLength(1);
    });
  });

  describe('revoke()', () => {
    it('should delegate to service.revoke with tenant and id', async () => {
      const result = await controller.revoke(mockTenant, 'key-1');

      expect(service.revoke).toHaveBeenCalledWith(mockTenant, 'key-1');
      expect(result.isActive).toBe(false);
    });
  });

  describe('remove()', () => {
    it('should delegate to service.remove and return success', async () => {
      const result = await controller.remove(mockTenant, 'key-1');

      expect(service.remove).toHaveBeenCalledWith(mockTenant, 'key-1');
      expect(result).toEqual({ success: true });
    });
  });
});
