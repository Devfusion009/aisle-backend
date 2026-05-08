import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { ApiKey } from '../../database/entities/api-key.entity';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { CreateApiKeyDto, ApiKeyResponse, ApiKeyCreatedResponse } from './dto/api-key.dto';

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  /** Generate a new API key, store its hash, return plaintext once */
  async create(tenant: TenantContext, dto: CreateApiKeyDto): Promise<ApiKeyCreatedResponse> {
    const rawKey = `vrs_live_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 20) + '...';

    const entity = this.apiKeyRepository.create({
      tenantId: tenant.tenantId,
      name: dto.name,
      description: dto.description,
      provider: dto.provider || 'openai',
      model: dto.model || 'gpt-4o-mini',
      systemPrompt: dto.systemPrompt ?? null,
      authorizedAssistantIds: dto.authorizedAssistantIds ?? [],
      keyHash,
      keyPrefix,
      isActive: true,
    });

    const saved = await this.apiKeyRepository.save(entity);

    return { ...this.toResponse(saved), fullKey: rawKey };
  }

  async findAll(tenant: TenantContext): Promise<ApiKeyResponse[]> {
    const keys = await this.apiKeyRepository.find({
      where: { tenantId: tenant.tenantId },
      order: { createdAt: 'DESC' },
    });
    return keys.map(this.toResponse);
  }

  async revoke(tenant: TenantContext, id: string): Promise<ApiKeyResponse> {
    const key = await this.apiKeyRepository.findOne({
      where: { id, tenantId: tenant.tenantId },
    });
    if (!key) throw new NotFoundException('API key not found');
    key.isActive = false;
    return this.toResponse(await this.apiKeyRepository.save(key));
  }

  async remove(tenant: TenantContext, id: string): Promise<void> {
    const key = await this.apiKeyRepository.findOne({
      where: { id, tenantId: tenant.tenantId },
    });
    if (!key) throw new NotFoundException('API key not found');
    await this.apiKeyRepository.remove(key);
  }

  /** Validate a raw key string — returns the ApiKey entity with tenantId */
  async validateKey(rawKey: string): Promise<ApiKey> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const key = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
    });
    if (!key) throw new UnauthorizedException('Invalid or revoked API key');

    // Update lastUsedAt (fire and forget)
    this.apiKeyRepository.update(key.id, { lastUsedAt: new Date() }).catch(() => {});

    return key;
  }

  private toResponse(key: ApiKey): ApiKeyResponse {
    return {
      id: key.id,
      name: key.name,
      description: key.description ?? null,
      keyPrefix: key.keyPrefix,
      provider: key.provider,
      model: key.model,
      systemPrompt: key.systemPrompt ?? null,
      authorizedAssistantIds: key.authorizedAssistantIds ?? [],
      isActive: key.isActive,
      lastUsedAt: key.lastUsedAt ?? null,
      createdAt: key.createdAt,
    };
  }
}
