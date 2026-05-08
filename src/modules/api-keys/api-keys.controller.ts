import { Controller, Get, Post, Delete, Body, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/api-key.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { UserRole } from '../../common/interfaces/tenant-context.interface';

@Controller('api-keys')
@Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  /** POST /api-keys — create a new key */
  @Post()
  async create(@Tenant() tenant: TenantContext, @Body() dto: CreateApiKeyDto) {
    return this.apiKeysService.create(tenant, dto);
  }

  /** GET /api-keys — list all keys (hashed, no plaintext) */
  @Get()
  async findAll(@Tenant() tenant: TenantContext) {
    return this.apiKeysService.findAll(tenant);
  }

  /** POST /api-keys/:id/revoke — disable without deleting */
  @Post(':id/revoke')
  async revoke(@Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.apiKeysService.revoke(tenant, id);
  }

  /** DELETE /api-keys/:id — permanently delete */
  @Delete(':id')
  async remove(@Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.apiKeysService.remove(tenant, id);
    return { success: true };
  }
}
