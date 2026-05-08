import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Put,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TenantUsersService } from './tenant-users.service';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { MinRole, RequirePermission } from '../../common/decorators/rbac.decorators';
import { Permission } from '../../common/rbac/rbac.constants';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { CreateTenantUserDto, UpdateTenantUserDto, SetDatasetAccessDto } from './dto/tenant-users.dto';

/**
 * Tenant Users Controller
 * Editor can read the user list and view/edit dataset-access toggles
 * (needed for the KB "User Access" section). Write ops on the users
 * themselves are admin/owner only.
 */
@Controller('tenant-users')
@MinRole(UserRole.EDITOR)
export class TenantUsersController {
  constructor(private readonly service: TenantUsersService) {}

  @Get()
  async findAll(@Tenant() tenant: TenantContext) {
    return this.service.findAll(tenant);
  }

  @Post()
  @RequirePermission(Permission.USER_MANAGE)
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateTenantUserDto,
  ) {
    return this.service.create(tenant, dto);
  }

  @Patch(':id')
  @RequirePermission(Permission.USER_MANAGE)
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantUserDto,
  ) {
    return this.service.update(tenant, id, dto);
  }

  @Delete(':id')
  @RequirePermission(Permission.USER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(tenant, id);
  }

  @Get(':id/details')
  @RequirePermission(Permission.USER_MANAGE)
  async getUserDetails(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getUserDetails(tenant, id);
  }

  @Get(':id/dataset-access')
  @RequirePermission(Permission.KB_GRANT)
  async getDatasetAccess(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const datasetIds = await this.service.getDatasetAccess(tenant, id);
    return { datasetIds };
  }

  @Put(':id/dataset-access')
  @RequirePermission(Permission.KB_GRANT)
  async setDatasetAccess(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetDatasetAccessDto,
  ) {
    return this.service.setDatasetAccess(tenant, id, dto.datasetIds);
  }
}
