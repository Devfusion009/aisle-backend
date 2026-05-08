import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { Assistant, LLMProvider } from '../../database/entities/assistant.entity';
import { AssistantDataset } from '../../database/entities/assistant-dataset.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { getPlanLimits } from '../../common/constants/plan-limits';
import { Conversation } from '../../database/entities/conversation.entity';
import { Document } from '../../database/entities/document.entity';
import { CreateAssistantDto, UpdateAssistantDto, AssistantResponse, DatasetResponse } from './dto/assistant.dto';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Assistants Service
 * Manages AI assistant CRUD operations with tenant isolation.
 */
// Heuristic prompt-injection signals. Matching does NOT block the change —
// system prompts legitimately contain phrases like "ignore" or "do not"
// (e.g. "ignore the user if they ask for medical advice"), so a regex
// reject would produce false positives. Instead these flags are written
// to the audit log so a security review can spot suspicious edits without
// having to re-read every prompt body.
const PROMPT_INJECTION_SIGNALS: { name: string; pattern: RegExp }[] = [
  { name: 'ignore_previous', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)\b/i },
  { name: 'disclose_secrets', pattern: /\b(?:reveal|disclose|leak|exfiltrate|print|dump)\b.*\b(?:tokens?|secrets?|api[_\s-]?keys?|passwords?|credentials?|env(?:ironment)?\s+variables?)\b/i },
  { name: 'jailbreak_persona', pattern: /\b(?:you\s+are\s+now|pretend\s+to\s+be|act\s+as)\s+(?:DAN|jailbroken|unrestricted|admin|root)\b/i },
  { name: 'override_safety', pattern: /\b(?:disable|bypass|override)\s+(?:safety|content[\s-]?filter|moderation)\b/i },
];

function detectPromptInjectionSignals(prompt: string): string[] {
  return PROMPT_INJECTION_SIGNALS.filter((s) => s.pattern.test(prompt)).map((s) => s.name);
}

@Injectable()
export class AssistantsService {
  private readonly logger = new Logger(AssistantsService.name);

  constructor(
    @InjectRepository(Assistant)
    private readonly assistantRepository: Repository<Assistant>,
    @InjectRepository(AssistantDataset)
    private readonly assistantDatasetRepository: Repository<AssistantDataset>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a new assistant
   * CRITICAL: tenantId is enforced at creation
   */
  async create(tenant: TenantContext, dto: CreateAssistantDto): Promise<AssistantResponse> {
    const tenantEntity = await this.tenantRepository.findOne({ where: { id: tenant.tenantId } });
    if (!tenantEntity) throw new NotFoundException('Tenant not found');

    const maxAssistants = getPlanLimits(tenantEntity.plan).maxAssistants;

    const count = await this.assistantRepository.count({ where: { tenantId: tenant.tenantId, isDataset: false } });
    if (count >= maxAssistants) {
      throw new ForbiddenException(`Your plan (${tenantEntity.plan}) limits you to ${maxAssistants} assistant(s). Please upgrade to create more.`);
    }

    const assistant = this.assistantRepository.create({
      ...dto,
      tenantId: tenant.tenantId, // ENFORCE tenant isolation
    });

    const saved = await this.assistantRepository.save(assistant);

    // Audit: same trail as update(). Created prompts are just as impactful
    // as edited ones, since the next user to chat with this assistant will
    // run under whatever instructions an admin baked in here.
    const initialPrompt = saved.systemPrompt ?? '';
    const newHash = createHash('sha256').update(initialPrompt).digest('hex').slice(0, 16);
    const signals = detectPromptInjectionSignals(initialPrompt);
    this.logger.log(
      `event=assistant_created ` +
      `assistantId=${saved.id} assistantName="${saved.name}" ` +
      `tenantId=${tenant.tenantId} ` +
      `actorUserId=${tenant.userId} actorEmail=${tenant.email} actorRole=${tenant.role} ` +
      `promptLen=${initialPrompt.length} promptHash=${newHash} ` +
      `injectionSignals=[${signals.join(',')}]`,
    );
    if (signals.length > 0) {
      this.logger.warn(
        `Suspicious system-prompt content on new assistant ${saved.id} ` +
        `(actor=${tenant.email}, signals=${signals.join(',')}). Review the audit log.`,
      );
    }

    return this.toResponse(saved, 0, 0, []);
  }

  /**
   * Get all assistants for tenant with conversation counts and linked datasets
   * CRITICAL: Always filter by tenantId
   */
  async findAll(tenant: TenantContext): Promise<AssistantResponse[]> {
    const assistants = await this.assistantRepository.find({
      where: { tenantId: tenant.tenantId, isDataset: false }, // ENFORCE tenant isolation; exclude dataset folders
      order: { createdAt: 'DESC' },
    });

    if (assistants.length === 0) return [];

    const assistantIds = assistants.map(a => a.id);

    // Get conversation counts per assistant
    const convCounts = await this.conversationRepository
      .createQueryBuilder('c')
      .select('c.assistantId', 'assistantId')
      .addSelect('COUNT(c.id)', 'count')
      .where('c.tenantId = :tenantId', { tenantId: tenant.tenantId })
      .andWhere('c.assistantId IN (:...ids)', { ids: assistantIds })
      .groupBy('c.assistantId')
      .getRawMany();

    const convCountMap: Record<string, number> = {};
    for (const row of convCounts) {
      convCountMap[row.assistantId] = parseInt(row.count, 10);
    }

    // Get all dataset links for these assistants
    const datasetLinks = await this.assistantDatasetRepository.find({
      where: { tenantId: tenant.tenantId, assistantId: In(assistantIds) },
    });

    // Get dataset names for linked datasets
    const linkedDatasetIds = [...new Set(datasetLinks.map(l => l.datasetId))];
    let datasetNameMap: Record<string, string> = {};
    if (linkedDatasetIds.length > 0) {
      const datasets = await this.assistantRepository.find({
        where: { id: In(linkedDatasetIds), tenantId: tenant.tenantId },
        select: ['id', 'name'],
      });
      for (const d of datasets) {
        datasetNameMap[d.id] = d.name;
      }
    }

    // Build dataset list per assistant
    const datasetsPerAssistant: Record<string, { id: string; name: string }[]> = {};
    for (const link of datasetLinks) {
      if (!datasetsPerAssistant[link.assistantId]) {
        datasetsPerAssistant[link.assistantId] = [];
      }
      const name = datasetNameMap[link.datasetId];
      if (name) {
        datasetsPerAssistant[link.assistantId].push({ id: link.datasetId, name });
      }
    }

    return assistants.map((a) => this.toResponse(
      a,
      convCountMap[a.id] || 0,
      datasetsPerAssistant[a.id]?.length || 0,
      datasetsPerAssistant[a.id] || [],
    ));
  }

  /**
   * Get a specific assistant by ID
   * CRITICAL: Verify tenant ownership
   */
  async findOne(tenant: TenantContext, id: string): Promise<AssistantResponse> {
    const assistant = await this.assistantRepository.findOne({
      where: { id, tenantId: tenant.tenantId }, // ENFORCE tenant isolation
    });

    if (!assistant) {
      throw new NotFoundException(`Assistant with ID "${id}" not found`);
    }

    // Get conversation count
    const convCount = await this.conversationRepository.count({
      where: { assistantId: id, tenantId: tenant.tenantId },
    });

    // Get linked datasets
    const links = await this.assistantDatasetRepository.find({
      where: { assistantId: id, tenantId: tenant.tenantId },
    });
    const datasetIds = links.map(l => l.datasetId);
    let linkedDatasets: { id: string; name: string }[] = [];
    if (datasetIds.length > 0) {
      const datasets = await this.assistantRepository.find({
        where: { id: In(datasetIds), tenantId: tenant.tenantId },
        select: ['id', 'name'],
      });
      linkedDatasets = datasets.map(d => ({ id: d.id, name: d.name }));
    }

    return this.toResponse(assistant, convCount, linkedDatasets.length, linkedDatasets);
  }

  /**
   * Get assistant entity (for internal use)
   */
  async findOneEntity(tenantId: string, id: string): Promise<Assistant> {
    const assistant = await this.assistantRepository.findOne({
      where: { id, tenantId },
    });

    if (!assistant) {
      throw new NotFoundException(`Assistant with ID "${id}" not found`);
    }

    return assistant;
  }

  /**
   * Update an assistant
   * CRITICAL: Verify tenant ownership before update
   */
  async update(tenant: TenantContext, id: string, dto: UpdateAssistantDto): Promise<AssistantResponse> {
    const assistant = await this.findOneEntity(tenant.tenantId, id);

    // Audit: capture system-prompt changes BEFORE the patch is applied so we
    // can record the previous value's fingerprint alongside the new one.
    // System prompts shape every downstream LLM response, so a malicious or
    // compromised admin could silently rewrite the assistant's behaviour;
    // this gives the team an append-only trail to review and revert.
    if (dto.systemPrompt !== undefined && dto.systemPrompt !== assistant.systemPrompt) {
      const oldPrompt = assistant.systemPrompt ?? '';
      const newPrompt = dto.systemPrompt;
      const oldHash = createHash('sha256').update(oldPrompt).digest('hex').slice(0, 16);
      const newHash = createHash('sha256').update(newPrompt).digest('hex').slice(0, 16);
      const signals = detectPromptInjectionSignals(newPrompt);

      this.logger.log(
        `event=assistant_system_prompt_change ` +
        `assistantId=${id} assistantName="${assistant.name}" ` +
        `tenantId=${tenant.tenantId} ` +
        `actorUserId=${tenant.userId} actorEmail=${tenant.email} actorRole=${tenant.role} ` +
        `oldLen=${oldPrompt.length} newLen=${newPrompt.length} ` +
        `oldHash=${oldHash} newHash=${newHash} ` +
        `injectionSignals=[${signals.join(',')}]`,
      );

      if (signals.length > 0) {
        // Surface suspicious edits at WARN so they pop in standard log views
        // without needing a custom dashboard. The change is still applied —
        // legitimate prompts can match these heuristics — but the line above
        // already recorded who did it.
        this.logger.warn(
          `Suspicious system-prompt content saved on assistant ${id} ` +
          `(actor=${tenant.email}, signals=${signals.join(',')}). Review the audit log.`,
        );
      }
    }

    // Apply updates
    Object.assign(assistant, dto);

    const saved = await this.assistantRepository.save(assistant);

    // Get conversation count
    const convCount = await this.conversationRepository.count({
      where: { assistantId: id, tenantId: tenant.tenantId },
    });

    // Get linked datasets
    const links = await this.assistantDatasetRepository.find({
      where: { assistantId: id, tenantId: tenant.tenantId },
    });
    const datasetIds = links.map(l => l.datasetId);
    let linkedDatasets: { id: string; name: string }[] = [];
    if (datasetIds.length > 0) {
      const datasets = await this.assistantRepository.find({
        where: { id: In(datasetIds), tenantId: tenant.tenantId },
        select: ['id', 'name'],
      });
      linkedDatasets = datasets.map(d => ({ id: d.id, name: d.name }));
    }

    return this.toResponse(saved, convCount, linkedDatasets.length, linkedDatasets);
  }

  /**
   * Delete an assistant
   * CRITICAL: Verify tenant ownership before delete
   */
  async remove(tenant: TenantContext, id: string): Promise<void> {
    const assistant = await this.findOneEntity(tenant.tenantId, id);
    await this.assistantRepository.remove(assistant);
  }

  /**
   * Update linked datasets for an assistant
   * Replaces all existing links with the new set
   */
  async updateDatasets(tenant: TenantContext, assistantId: string, datasetIds: string[]): Promise<{ id: string; name: string }[]> {
    // Verify assistant belongs to tenant
    await this.findOneEntity(tenant.tenantId, assistantId);

    // Verify all datasets belong to the same tenant
    if (datasetIds.length > 0) {
      const validDatasets = await this.assistantRepository.find({
        where: { id: In(datasetIds), tenantId: tenant.tenantId, isDataset: true },
        select: ['id', 'name'],
      });

      const validIds = new Set(validDatasets.map(d => d.id));
      const invalidIds = datasetIds.filter(id => !validIds.has(id));
      if (invalidIds.length > 0) {
        throw new NotFoundException(`Datasets not found: ${invalidIds.join(', ')}`);
      }
    }

    // Delete old + insert new links atomically in a transaction
    const uniqueIds = [...new Set(datasetIds.filter(id => id !== assistantId))];
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AssistantDataset, {
        assistantId,
        tenantId: tenant.tenantId,
      });

      if (uniqueIds.length > 0) {
        const newLinks = uniqueIds.map(datasetId =>
          manager.create(AssistantDataset, {
            assistantId,
            datasetId,
            tenantId: tenant.tenantId,
          }),
        );
        await manager.save(newLinks);
      }
    });

    // Return the updated dataset list
    if (uniqueIds.length === 0) return [];
    const datasets = await this.assistantRepository.find({
      where: { id: In(uniqueIds), tenantId: tenant.tenantId },
      select: ['id', 'name'],
    });
    return datasets.map(d => ({ id: d.id, name: d.name }));
  }

  /**
   * Get linked datasets for an assistant
   */
  async getDatasets(tenant: TenantContext, assistantId: string): Promise<{ id: string; name: string }[]> {
    await this.findOneEntity(tenant.tenantId, assistantId);

    const links = await this.assistantDatasetRepository.find({
      where: { assistantId, tenantId: tenant.tenantId },
    });

    if (links.length === 0) return [];

    const datasetIds = links.map(l => l.datasetId);
    const datasets = await this.assistantRepository.find({
      where: { id: In(datasetIds), tenantId: tenant.tenantId },
      select: ['id', 'name'],
    });
    return datasets.map(d => ({ id: d.id, name: d.name }));
  }

  // ── Dataset (knowledge-base folder) methods ────────────────────────────

  async findAllDatasets(tenant: TenantContext): Promise<DatasetResponse[]> {
    const datasets = await this.assistantRepository.find({
      where: { tenantId: tenant.tenantId, isDataset: true },
      order: { createdAt: 'DESC' },
      select: ['id', 'name', 'createdAt', 'updatedAt'],
    });
    return datasets.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt }));
  }

  async createDataset(tenant: TenantContext, name: string): Promise<DatasetResponse> {
    const tenantEntity = await this.tenantRepository.findOne({ where: { id: tenant.tenantId } });
    if (!tenantEntity) throw new NotFoundException('Tenant not found');

    const maxDatasets = getPlanLimits(tenantEntity.plan).maxDatasets;

    const count = await this.assistantRepository.count({ where: { tenantId: tenant.tenantId, isDataset: true } });
    if (count >= maxDatasets) {
      throw new ForbiddenException(`Your plan (${tenantEntity.plan}) limits you to ${maxDatasets} datasets. Please upgrade to create more.`);
    }

    const dataset = this.assistantRepository.create({
      tenantId: tenant.tenantId,
      name,
      isDataset: true,
      systemPrompt: '',
      provider: LLMProvider.OPENROUTER,
      model: 'openai/gpt-4o-mini',
    });
    const saved = await this.assistantRepository.save(dataset);
    return { id: saved.id, name: saved.name, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
  }

  async renameDataset(tenant: TenantContext, id: string, name: string): Promise<DatasetResponse> {
    const dataset = await this.assistantRepository.findOne({
      where: { id, tenantId: tenant.tenantId, isDataset: true },
    });
    if (!dataset) throw new NotFoundException(`Dataset with ID "${id}" not found`);
    dataset.name = name;
    // Defensive: ensure numeric columns are numbers before the validation
    // subscriber runs on save(). The column transformer normally handles this,
    // but this makes the rename path resilient to changes in entity metadata.
    dataset.temperature = Number(dataset.temperature);
    const saved = await this.assistantRepository.save(dataset);
    return { id: saved.id, name: saved.name, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
  }

  async removeDataset(tenant: TenantContext, id: string): Promise<void> {
    const dataset = await this.assistantRepository.findOne({
      where: { id, tenantId: tenant.tenantId, isDataset: true },
    });
    if (!dataset) throw new NotFoundException(`Dataset with ID "${id}" not found`);
    await this.assistantRepository.remove(dataset);
  }

  /**
   * Convert entity to response DTO
   */
  private toResponse(
    assistant: Assistant,
    conversationCount: number = 0,
    datasetCount: number = 0,
    linkedDatasets: { id: string; name: string }[] = [],
  ): AssistantResponse {
    // If an assistant requires RAG but has no datasets linked (e.g., they were deleted),
    // it cannot function properly and should be considered inactive.
    const dynamicallyActive = assistant.ragEnabled && datasetCount === 0 
      ? false 
      : assistant.isActive;

    return {
      id: assistant.id,
      name: assistant.name,
      description: assistant.description,
      systemPrompt: assistant.systemPrompt,
      provider: assistant.provider,
      model: assistant.model,
      temperature: Number(assistant.temperature),
      maxTokens: assistant.maxTokens,
      ragEnabled: assistant.ragEnabled,
      ragTopK: assistant.ragTopK,
      isActive: dynamicallyActive,
      createdAt: assistant.createdAt,
      updatedAt: assistant.updatedAt,
      conversationCount,
      datasetCount,
      linkedDatasets,
    };
  }
}
