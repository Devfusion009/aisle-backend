import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { KnowledgeService } from './knowledge.service';
import { UploadDocumentDto, DocumentResponse } from './dto/knowledge.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RequirePermission, KbAccess } from '../../common/decorators/rbac.decorators';
import { Permission } from '../../common/rbac/rbac.constants';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Knowledge Controller
 * REST API endpoints for knowledge base management.
 *
 * Gating model:
 *   • /knowledge/*         → KB_READ / KB_WRITE (admin/owner/editor)
 *   • /knowledge/my-*      → @KbAccess — any role with KB_READ passes; a regular
 *                            USER must be high-priority AND hold an explicit grant.
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) { }

  /** GET /knowledge/my-datasets — all datasets the caller has read access to */
  @Get('my-datasets')
  @KbAccess({ source: 'param', optional: true })
  async getMyDatasets(@Tenant() tenant: TenantContext) {
    return this.knowledgeService.findUserDatasets(tenant);
  }

  /** GET /knowledge/my-datasets/ids — ids only (used by frontend useKbAccess hook) */
  @Get('my-datasets/ids')
  @KbAccess({ source: 'param', optional: true })
  async getMyDatasetIds(@Tenant() tenant: TenantContext): Promise<string[]> {
    return this.knowledgeService.findUserDatasetIds(tenant);
  }

  /** GET /knowledge/my-datasets/:datasetId/documents */
  @Get('my-datasets/:datasetId/documents')
  @KbAccess({ source: 'param', key: 'datasetId' })
  async getMyDatasetDocuments(
    @Tenant() tenant: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ) {
    return this.knowledgeService.findUserDatasetDocuments(tenant, datasetId);
  }

  /** POST /knowledge/upload — admin/owner/editor only */
  @Post('upload')
  @RequirePermission(Permission.KB_WRITE)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Tenant() tenant: TenantContext,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<DocumentResponse> {
    return this.knowledgeService.uploadDocument(tenant, dto, file);
  }

  /** GET /knowledge — admin/owner/editor only (tenant-wide list) */
  @Get()
  @RequirePermission(Permission.KB_READ)
  async findAll(
    @Tenant() tenant: TenantContext,
    @Query('assistantId') assistantId?: string,
  ): Promise<DocumentResponse[]> {
    return this.knowledgeService.findAll(tenant, assistantId);
  }

  /** GET /knowledge/:id — single document metadata (admin/owner/editor) */
  @Get(':id')
  @RequirePermission(Permission.KB_READ)
  async findOne(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentResponse> {
    const doc = await this.knowledgeService.findOne(tenant, id);
    return {
      id: doc.id,
      assistantId: doc.assistantId,
      filename: doc.filename,
      mimeType: doc.mimeType,
      fileSize: Number(doc.fileSize),
      status: doc.status,
      chunkCount: doc.chunkCount,
      characterCount: doc.characterCount,
      version: doc.version,
      uploadedBy: doc.uploadedBy ?? null,
      uploadedByName: doc.uploadedByName ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * GET /knowledge/:id/content
   * Document bytes. High-priority users reach this via the document's dataset
   * grant — the service layer re-verifies per-dataset access for non-KB_READ callers.
   */
  @Get(':id/content')
  async getContent(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: boolean,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { buf, etag, document } = await this.knowledgeService.getDocumentBuffer(tenant, id);

    if (req.headers['if-none-match'] === etag) {
      return res.status(HttpStatus.NOT_MODIFIED).end();
    }

    res.set({
      'Content-Type': document.mimeType,
      'Content-Length': String(buf.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${document.filename}"`,
      'ETag': etag,
      'Cache-Control': 'private, max-age=300',
    });

    res.end(buf);
  }

  /** GET /knowledge/:id/preview — HTML preview of DOCX/TXT */
  @Get(':id/preview')
  async getPreview(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { html, filename } = await this.knowledgeService.getDocumentPreview(tenant, id);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${filename}.html"`,
    });
    res.send(html);
  }

  /** DELETE /knowledge/:id — admin/owner/editor only */
  @Delete(':id')
  @RequirePermission(Permission.KB_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.knowledgeService.remove(tenant, id);
  }
}
