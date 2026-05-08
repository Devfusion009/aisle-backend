import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service.js';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockTenant: TenantContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  email: 'admin@example.com',
  role: UserRole.TENANT_OWNER,
};

function createMockApiKeyEntity(overrides: Partial<any> = {}) {
  return {
    id: 'key-1',
    tenantId: 'tenant-1',
    name: 'Test Key',
    description: 'A test key',
    keyHash: 'abc123hash',
    keyPrefix: 'vrs_live_abc12345...',
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: null,
    authorizedAssistantIds: [],
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let apiKeyRepo: any;

  beforeEach(() => {
    apiKeyRepo = {
      create: vi.fn().mockImplementation((data: any) => ({ ...data, id: 'key-new', createdAt: new Date() })),
      save: vi.fn().mockImplementation((entity: any) => Promise.resolve(entity)),
      find: vi.fn(),
      findOne: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    service = new ApiKeysService(apiKeyRepo);
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('should create an API key and return fullKey starting with vrs_live_', async () => {
      const dto = { name: 'Bot Key', provider: 'openai', model: 'gpt-4o-mini' };
      const result = await service.create(mockTenant, dto as any);

      expect(result.fullKey).toBeDefined();
      expect(result.fullKey).toMatch(/^vrs_live_/);
      expect(result.name).toBe('Bot Key');
      expect(apiKeyRepo.create).toHaveBeenCalled();
      expect(apiKeyRepo.save).toHaveBeenCalled();
    });

    it('should hash the key and store keyPrefix', async () => {
      const dto = { name: 'K', provider: 'openai', model: 'gpt-4o-mini' };
      await service.create(mockTenant, dto as any);

      const createCall = apiKeyRepo.create.mock.calls[0][0];
      expect(createCall.keyHash).toBeDefined();
      expect(createCall.keyHash.length).toBe(64); // SHA-256 hex
      expect(createCall.keyPrefix).toMatch(/^vrs_live_.*\.\.\.$/);
    });

    it('should apply default provider and model when not provided in dto', async () => {
      const dto = { name: 'Default Key' }; // no provider or model
      await service.create(mockTenant, dto as any);

      const createCall = apiKeyRepo.create.mock.calls[0][0];
      expect(createCall.provider).toBe('openai');
      expect(createCall.model).toBe('gpt-4o-mini');
    });
  });

  // ── findAll ────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('should return mapped key responses', async () => {
      const keys = [createMockApiKeyEntity(), createMockApiKeyEntity({ id: 'key-2', name: 'Key 2' })];
      apiKeyRepo.find.mockResolvedValue(keys);

      const result = await service.findAll(mockTenant);

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('keyPrefix');
      expect(result[0]).not.toHaveProperty('keyHash'); // should not expose hash
    });

    it('should return empty array when no keys exist', async () => {
      apiKeyRepo.find.mockResolvedValue([]);
      const result = await service.findAll(mockTenant);
      expect(result).toEqual([]);
    });

    it('should default authorizedAssistantIds to [] when key has null value', async () => {
      apiKeyRepo.find.mockResolvedValue([createMockApiKeyEntity({ authorizedAssistantIds: null })]);
      const result = await service.findAll(mockTenant);
      expect(result[0].authorizedAssistantIds).toEqual([]);
    });
  });

  // ── revoke ─────────────────────────────────────────────────────────────

  describe('revoke()', () => {
    it('should set isActive to false and return the key', async () => {
      const key = createMockApiKeyEntity();
      apiKeyRepo.findOne.mockResolvedValue(key);
      apiKeyRepo.save.mockImplementation((k: any) => Promise.resolve(k));

      const result = await service.revoke(mockTenant, 'key-1');

      expect(result.isActive).toBe(false);
    });

    it('should throw NotFoundException when key does not exist', async () => {
      apiKeyRepo.findOne.mockResolvedValue(null);

      await expect(service.revoke(mockTenant, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('should remove the key entity', async () => {
      const key = createMockApiKeyEntity();
      apiKeyRepo.findOne.mockResolvedValue(key);

      await service.remove(mockTenant, 'key-1');

      expect(apiKeyRepo.remove).toHaveBeenCalledWith(key);
    });

    it('should throw NotFoundException when key does not exist', async () => {
      apiKeyRepo.findOne.mockResolvedValue(null);

      await expect(service.remove(mockTenant, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── validateKey ────────────────────────────────────────────────────────

  describe('validateKey()', () => {
    it('should return the key entity for a valid raw key', async () => {
      const key = createMockApiKeyEntity();
      apiKeyRepo.findOne.mockResolvedValue(key);

      const result = await service.validateKey('vrs_live_some_raw_key');

      expect(result.id).toBe('key-1');
      expect(apiKeyRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });

    it('should throw UnauthorizedException for an invalid key', async () => {
      apiKeyRepo.findOne.mockResolvedValue(null);

      await expect(service.validateKey('vrs_live_invalid')).rejects.toThrow(UnauthorizedException);
    });

    it('should fire-and-forget update lastUsedAt on valid key', async () => {
      const key = createMockApiKeyEntity();
      apiKeyRepo.findOne.mockResolvedValue(key);

      await service.validateKey('vrs_live_valid');

      expect(apiKeyRepo.update).toHaveBeenCalledWith(
        'key-1',
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });
  });
});
