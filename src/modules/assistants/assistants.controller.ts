import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AssistantsService } from './assistants.service';
import { CreateAssistantDto, UpdateAssistantDto, AssistantResponse } from './dto/assistant.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { MinRole, RequirePermission } from '../../common/decorators/rbac.decorators';
import { Permission } from '../../common/rbac/rbac.constants';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Assistants Controller
 * Read access (ASSISTANT_READ) is open to all roles including USER so the chat
 * assistant picker works. Write actions (ASSISTANT_MANAGE) are locked to admins.
 */
@Controller('assistants')
export class AssistantsController {
  constructor(private readonly assistantsService: AssistantsService) { }

  @Post()
  @RequirePermission(Permission.ASSISTANT_MANAGE)
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateAssistantDto,
  ): Promise<AssistantResponse> {
    return this.assistantsService.create(tenant, dto);
  }

  @Get()
  @RequirePermission(Permission.ASSISTANT_READ)
  async findAll(@Tenant() tenant: TenantContext): Promise<AssistantResponse[]> {
    return this.assistantsService.findAll(tenant);
  }

  @Get(':id')
  @RequirePermission(Permission.ASSISTANT_READ)
  async findOne(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantResponse> {
    return this.assistantsService.findOne(tenant, id);
  }

  @Patch(':id')
  @RequirePermission(Permission.ASSISTANT_MANAGE)
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssistantDto,
  ): Promise<AssistantResponse> {
    return this.assistantsService.update(tenant, id, dto);
  }

  @Delete(':id')
  @RequirePermission(Permission.ASSISTANT_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.assistantsService.remove(tenant, id);
  }

  @Get(':id/datasets')
  @RequirePermission(Permission.ASSISTANT_READ)
  async getDatasets(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string; name: string }[]> {
    return this.assistantsService.getDatasets(tenant, id);
  }

  @Put(':id/datasets')
  @RequirePermission(Permission.ASSISTANT_MANAGE)
  async updateDatasets(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { datasetIds: string[] },
  ): Promise<{ id: string; name: string }[]> {
    return this.assistantsService.updateDatasets(tenant, id, body.datasetIds || []);
  }
}
