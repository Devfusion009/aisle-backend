import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AssistantsService } from './assistants.service';
import { CreateDatasetDto, RenameDatasetDto, DatasetResponse } from './dto/assistant.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RequirePermission } from '../../common/decorators/rbac.decorators';
import { Permission } from '../../common/rbac/rbac.constants';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Datasets Controller
 * Folder management for knowledge-base datasets. Read is gated by KB_READ
 * (admin/owner/editor); write by KB_WRITE (admin/owner/editor).
 */
@Controller('datasets')
export class DatasetsController {
  constructor(private readonly assistantsService: AssistantsService) {}

  @Get()
  @RequirePermission(Permission.KB_READ)
  async findAll(@Tenant() tenant: TenantContext): Promise<DatasetResponse[]> {
    return this.assistantsService.findAllDatasets(tenant);
  }

  @Post()
  @RequirePermission(Permission.KB_WRITE)
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateDatasetDto,
  ): Promise<DatasetResponse> {
    return this.assistantsService.createDataset(tenant, dto.name);
  }

  @Patch(':id')
  @RequirePermission(Permission.KB_WRITE)
  async rename(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameDatasetDto,
  ): Promise<DatasetResponse> {
    return this.assistantsService.renameDataset(tenant, id, dto.name);
  }

  @Delete(':id')
  @RequirePermission(Permission.KB_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.assistantsService.removeDataset(tenant, id);
  }
}
