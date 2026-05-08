import { Controller, Get, Post, Delete, Patch, Body, Param, ParseUUIDPipe } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/webhook.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';

@Controller('webhooks')
@Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Get()
  getAll(@Tenant() t: TenantContext) {
    return this.svc.findAll(t);
  }

  @Post()
  create(@Tenant() t: TenantContext, @Body() dto: CreateWebhookDto) {
    return this.svc.create(t, dto);
  }

  @Patch(':id/toggle')
  toggle(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.toggle(t, id);
  }

  @Delete(':id')
  remove(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(t, id);
  }
}
