import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException, ForbiddenException, Logger, Inject, forwardRef } from '@nestjs/common';
import mammoth from 'mammoth';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In, DataSource } from 'typeorm';
import { Document, DocumentStatus } from '../../database/entities/document.entity';
import { DocumentChunk } from '../../database/entities/document-chunk.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { Assistant } from '../../database/entities/assistant.entity';
import { User } from '../../database/entities/user.entity';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';
import { StorageService } from './storage.service';
import { KbPermissionService } from './kb-permission.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { QuotasService } from '../quotas/quotas.service';
import { UploadDocumentDto, DocumentResponse } from './dto/knowledge.dto';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { Permission, roleHas } from '../../common/rbac/rbac.constants';

/**
 * Allowed MIME types for document upload
 */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Knowledge Service
 * Manages document upload, storage, and metadata.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Assistant)
    private readonly assistantRepository: Repository<Assistant>,
    @InjectRepository(UserDatasetAccess)
    private readonly accessRepository: Repository<UserDatasetAccess>,
    private readonly storageService: StorageService,
    private readonly kbPermissions: KbPermissionService,
    @Inject(forwardRef(() => IngestionService))
    private readonly ingestionService: IngestionService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly quotas: QuotasService,
    private readonly dataSource: DataSource,
  ) { }

  /**
   * Upload and process a document
   */
  async uploadDocument(
    tenant: TenantContext,
    dto: UploadDocumentDto,
    file: Express.Multer.File,
  ): Promise<DocumentResponse> {
    // Validate file
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type. Allowed: PDF, DOCX, TXT. Received: ${file.mimetype}`,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(`File too large. Maximum size: 50MB`);
    }

    const tenantEntity = await this.tenantRepository.findOne({ where: { id: tenant.tenantId } });
    if (!tenantEntity) throw new NotFoundException('Tenant not found');

    // ── Duplicate detection ──────────────────────────────────────────────
    const existing = await this.documentRepository.findOne({
      where: {
        tenantId: tenant.tenantId,
        ...(dto.assistantId ? { assistantId: dto.assistantId } : { assistantId: IsNull() }),
        filename: file.originalname,
      },
    });

    if (existing && Number(existing.fileSize) === file.size) {
      // Identical file — return the existing record, skip re-upload (no quota change)
      this.logger.log(`Skipping duplicate upload: ${file.originalname} (same size)`);
      if (!existing.uploadedBy) {
        try {
          const uploader = await this.dataSource.getRepository(User).findOne({
            where: { id: tenant.userId, tenantId: tenant.tenantId },
            select: ['name'],
          });
          await this.documentRepository.update(
            { id: existing.id },
            { uploadedBy: tenant.userId, uploadedByName: uploader?.name ?? null },
          );
          existing.uploadedBy = tenant.userId;
          existing.uploadedByName = uploader?.name ?? null;
        } catch { /* ignore */ }
      }
      return this.toResponse(existing);
    }

    // Storage quota: subtract the bytes we'll reclaim from a replacement so
    // a same-filename swap is not double-counted against the cap.
    await this.quotas.assertStorageQuota(
      tenant.tenantId,
      file.size,
      existing ? Number(existing.fileSize) : 0,
    );

    if (existing) {
      // Same filename but different content — replace the old document
      this.logger.log(`Replacing document: ${file.originalname} (size changed ${existing.fileSize} → ${file.size})`);

      // Clean up external data first (best-effort, non-transactional)
      try { await this.vectorSearchService.deleteDocumentVectors(existing.id); } catch {}
      try { await this.storageService.deleteFile(existing.s3Key); } catch {}

      // Delete DB records atomically (chunks + document in one transaction)
      await this.dataSource.transaction(async (manager) => {
        await manager.delete(DocumentChunk, { documentId: existing.id, tenantId: tenant.tenantId });
        await manager.remove(existing);
      });
    }

    // Generate S3 key and upload
    const s3Key = this.storageService.generateKey(tenant.tenantId, file.originalname);

    try {
      await this.storageService.uploadFile(s3Key, file.buffer, file.mimetype);
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: ${s3Key}`, error);
      throw new InternalServerErrorException('Failed to upload document to storage');
    }

    // Resolve uploader name (best-effort, non-blocking)
    let uploaderName: string | null = null;
    try {
      const uploader = await this.dataSource.getRepository(User).findOne({
        where: { id: tenant.userId, tenantId: tenant.tenantId },
        select: ['name'],
      });
      uploaderName = uploader?.name ?? null;
    } catch { /* ignore */ }

    // Create document record
    let saved: Document;
    try {
      const document = this.documentRepository.create({
        tenantId: tenant.tenantId,
        assistantId: dto.assistantId ?? null,
        filename: file.originalname,
        s3Key,
        mimeType: file.mimetype,
        fileSize: file.size,
        status: DocumentStatus.PENDING,
        uploadedBy: tenant.userId,
        uploadedByName: uploaderName,
      });

      saved = await this.documentRepository.save(document);
    } catch (error) {
      // DB save failed — clean up the already-uploaded S3 file to avoid orphans
      this.logger.error(`Failed to save document record, cleaning up S3 file: ${s3Key}`, error);
      try {
        await this.storageService.deleteFile(s3Key);
      } catch (cleanupError) {
        this.logger.error(`Failed to clean up orphaned S3 file: ${s3Key}`, cleanupError);
      }
      throw new InternalServerErrorException('Failed to save document record');
    }

    // Trigger async ingestion (best-effort, does not block response)
    this.ingestionService.queueDocument(saved.id).catch((err) => {
      this.logger.error(`Failed to queue document ${saved.id} for ingestion`, err);
    });

    return this.toResponse(saved);
  }

  /**
   * Get all documents for an assistant
   */
  async findAll(tenant: TenantContext, assistantId?: string): Promise<DocumentResponse[]> {
    const whereClause: any = { tenantId: tenant.tenantId };
    if (assistantId) {
      whereClause.assistantId = assistantId;
    }

    const documents = await this.documentRepository.find({
      where: whereClause,
      order: { createdAt: 'DESC' },
    });

    return documents.map((d) => this.toResponse(d));
  }

  /**
   * Get a specific document. Callers without tenant-wide KB_READ (i.e. regular
   * users) must still have a per-dataset grant for the document's dataset.
   */
  async findOne(tenant: TenantContext, id: string): Promise<Document> {
    const document = await this.documentRepository.findOne({
      where: { id, tenantId: tenant.tenantId },
    });

    if (!document) {
      throw new NotFoundException(`Document with ID "${id}" not found`);
    }

    const tenantWideRead = roleHas(tenant.role, Permission.KB_READ);
    if (!tenantWideRead) {
      if (tenant.role !== UserRole.USER || tenant.priority !== 'high') {
        throw new ForbiddenException('Knowledge base access denied');
      }
      if (!document.assistantId) {
        // Tenant-root document (no dataset) — regular users can never see it.
        throw new ForbiddenException('You do not have access to this document');
      }
      const ok = await this.kbPermissions.userHasAccess(
        tenant.userId,
        tenant.tenantId,
        document.assistantId,
      );
      if (!ok) {
        throw new ForbiddenException('You do not have access to this document');
      }
    }

    return document;
  }

  /**
   * Get a document's file stream
   */
  async getDocumentStream(
    tenant: TenantContext,
    id: string,
  ): Promise<{ stream: NodeJS.ReadableStream; document: Document }> {
    const document = await this.findOne(tenant, id);
    const stream = await this.storageService.getFileStream(document.s3Key);
    return { stream, document };
  }

  /**
   * Get a document's contents as a Buffer (cached via Redis when small).
   *
   * Use this instead of `getDocumentStream` for endpoints that do not need a true
   * stream — the cache keeps Node's event loop off S3 for the common case of
   * small files (≤ 2 MiB, governed by `StorageService.CACHE_MAX_BYTES`).
   * Larger files will transparently bypass the cache.
   */
  async getDocumentBuffer(
    tenant: TenantContext,
    id: string,
  ): Promise<{ buf: Buffer; etag: string; document: Document }> {
    const document = await this.findOne(tenant, id);
    const { buf, etag } = await this.storageService.downloadFileCached(
      document.s3Key,
      document.mimeType,
    );
    return { buf, etag, document };
  }

  /**
   * Generate an HTML preview for viewable document types.
   * DOCX → HTML via mammoth. TXT → escaped HTML.
   */
  async getDocumentPreview(tenant: TenantContext, id: string): Promise<{ html: string; filename: string }> {
    const document = await this.findOne(tenant, id);
    const buffer = await this.storageService.downloadFile(document.s3Key);

    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let bodyHtml: string;

    if (document.mimeType === docxMime) {
      const result = await mammoth.convertToHtml({ buffer });
      bodyHtml = result.value || '<p><em>No content could be extracted from this document.</em></p>';
    } else if (document.mimeType === 'text/plain') {
      const text = buffer.toString('utf-8');
      bodyHtml = `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
    } else {
      throw new BadRequestException('Preview is not supported for this file type. Please use the download button.');
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${document.filename}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 32px 60px; line-height: 1.7; color: #1f2937; }
    h1, h2, h3, h4 { color: #111827; margin-top: 1.5em; }
    p { margin: 0.75em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    td, th { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    pre { background: #f3f4f6; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    img { max-width: 100%; height: auto; }
    .doc-title { font-size: 13px; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 32px; }
  </style>
</head>
<body>
  <p class="doc-title">${document.filename}</p>
  ${bodyHtml}
</body>
</html>`;

    return { html, filename: document.filename };
  }

  /**
   * Delete a document and its chunks
   * Uses best-effort cleanup: attempts all steps even if one fails,
   * and reports all errors at the end.
   */
  async remove(tenant: TenantContext, id: string): Promise<void> {
    const document = await this.findOne(tenant, id);
    const externalErrors: { step: string; error: unknown }[] = [];

    // Step 1: Delete external data first (best-effort, non-transactional)
    // These happen before DB deletion so we still have references if they fail
    try {
      await this.vectorSearchService.deleteDocumentVectors(id);
    } catch (error) {
      this.logger.error(`Failed to delete vectors for document ${id}`, error);
      externalErrors.push({ step: 'vector_delete', error });
    }

    try {
      await this.storageService.deleteFile(document.s3Key);
    } catch (error) {
      this.logger.error(`Failed to delete S3 file for document ${id}: ${document.s3Key}`, error);
      externalErrors.push({ step: 's3_delete', error });
    }

    // Step 2: Delete DB records atomically (chunks + document in one transaction)
    // If this fails, both chunks and document remain intact for retry
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.delete(DocumentChunk, { documentId: id, tenantId: tenant.tenantId });
        await manager.remove(document);
      });
    } catch (error) {
      this.logger.error(`Failed to delete document record and chunks for ${id}`, error);
      throw new InternalServerErrorException(
        `Failed to delete document from database. External cleanup status: ${externalErrors.length > 0 ? externalErrors.map(e => e.step).join(', ') + ' failed' : 'success'}. Check server logs.`,
      );
    }

    if (externalErrors.length > 0) {
      const failedSteps = externalErrors.map((e) => e.step).join(', ');
      this.logger.warn(
        `Document ${id} DB records deleted but external cleanup had ${externalErrors.length} error(s): ${failedSteps}`,
      );
    }

    this.logger.log(`Deleted document ${id} and all associated data`);
  }

  /**
   * Update document status
   */
  async updateStatus(
    id: string,
    status: DocumentStatus,
    updates?: { chunkCount?: number; characterCount?: number; errorMessage?: string },
  ): Promise<void> {
    try {
      await this.documentRepository.update(id, {
        status,
        ...updates,
      });
    } catch (error) {
      this.logger.error(`Failed to update status for document ${id} to ${status}`, error);
      throw new InternalServerErrorException(`Failed to update document status`);
    }
  }

  /**
   * Get datasets the current user has access to.
   * For admin/owner/editor: returns every dataset they have read access to (all of them).
   * For a regular high-priority user: returns only the datasets explicitly granted.
   */
  async findUserDatasets(tenant: TenantContext) {
    const datasetIds = await this.findUserDatasetIds(tenant);
    if (datasetIds.length === 0) return [];

    const datasets = await this.assistantRepository.find({
      where: { id: In(datasetIds), tenantId: tenant.tenantId, isDataset: true },
    });

    // Get doc counts per dataset
    const result = await Promise.all(
      datasets.map(async (ds) => {
        const docs = await this.documentRepository.find({
          where: { tenantId: tenant.tenantId, assistantId: ds.id },
        });
        return {
          id: ds.id,
          name: ds.name,
          docCount: docs.length,
          totalSize: docs.reduce((sum, d) => sum + Number(d.fileSize), 0),
        };
      }),
    );

    return result;
  }

  /**
   * Dataset ids the current caller can see:
   *   • KB_READ holders (admin/owner/editor) → every dataset in the tenant.
   *   • Regular high-priority users         → only explicitly-granted datasets.
   *   • Everyone else                        → [].
   * KbPermissionGuard has already validated the high-priority precondition.
   */
  async findUserDatasetIds(tenant: TenantContext): Promise<string[]> {
    if (roleHas(tenant.role, Permission.KB_READ)) {
      const datasets = await this.assistantRepository.find({
        where: { tenantId: tenant.tenantId, isDataset: true },
        select: ['id'],
      });
      return datasets.map((d) => d.id);
    }

    if (tenant.role === UserRole.USER && tenant.priority === 'high') {
      const ids = await this.kbPermissions.listGrantedDatasetIds(tenant.userId, tenant.tenantId);
      return [...ids];
    }

    return [];
  }

  /**
   * Get documents in a permitted dataset for the current user.
   * KbPermissionGuard has already enforced the per-dataset grant, but we
   * double-check at the service layer so the method is safe when called
   * from non-HTTP contexts too.
   */
  async findUserDatasetDocuments(tenant: TenantContext, datasetId: string): Promise<DocumentResponse[]> {
    const tenantWideRead = roleHas(tenant.role, Permission.KB_READ);

    if (!tenantWideRead) {
      if (tenant.role !== UserRole.USER || tenant.priority !== 'high') {
        throw new ForbiddenException('Only high-priority users can access knowledge bases.');
      }
      const ok = await this.kbPermissions.userHasAccess(tenant.userId, tenant.tenantId, datasetId);
      if (!ok) {
        throw new ForbiddenException('You do not have access to this dataset.');
      }
    }

    const documents = await this.documentRepository.find({
      where: { tenantId: tenant.tenantId, assistantId: datasetId },
      order: { createdAt: 'DESC' },
    });

    return documents.map((d) => this.toResponse(d));
  }

  private toResponse(document: Document): DocumentResponse {
    return {
      id: document.id,
      assistantId: document.assistantId,
      filename: document.filename,
      mimeType: document.mimeType,
      fileSize: Number(document.fileSize),
      status: document.status,
      chunkCount: document.chunkCount,
      characterCount: document.characterCount,
      version: document.version,
      uploadedBy: document.uploadedBy ?? null,
      uploadedByName: document.uploadedByName ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }
}
