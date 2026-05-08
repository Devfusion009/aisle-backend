import { Controller, Get, Post, Body, Param, Delete, Patch, Query, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import { MinRole } from '../../common/decorators/rbac.decorators';
import { Tenant as TenantCtx } from '../../common/decorators/tenant.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { CreateTenantDto, CreateUserBySuperAdminDto, UpdateTenantDto } from './dto/super-admin.dto';

@Controller('super-admin')
@MinRole(UserRole.PLATFORM_ADMIN)
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) { }

  @Get('tenants')
  getAllTenants() {
    return this.superAdminService.getAllTenants();
  }

  @Post('tenants')
  createTenant(@Body() dto: CreateTenantDto) {
    return this.superAdminService.createTenant(dto);
  }

  @Patch('tenants/:id')
  updateTenant(
    @TenantCtx() actor: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.superAdminService.updateTenant(id, dto, {
      userId: actor.userId,
      email: actor.email,
    });
  }

  @Delete('tenants/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.superAdminService.deleteTenant(id);
  }

  @Get('users')
  getAllUsers() {
    return this.superAdminService.getAllUsers();
  }

  @Post('users')
  createUser(@Body() dto: CreateUserBySuperAdminDto) {
    return this.superAdminService.createUser(dto);
  }

  @Patch('users/:id/role')
  updateUserRole(@Param('id') id: string, @Body('role') role: UserRole) {
    return this.superAdminService.updateUserRole(id, role);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string) {
    return this.superAdminService.deleteUser(id);
  }

  @Get('assistants')
  getAllAssistants() {
    return this.superAdminService.getAllAssistants();
  }

  @Get('documents')
  getAllDocuments() {
    return this.superAdminService.getAllDocuments();
  }

  @Get('token-usage')
  getTokenUsage(@Query('days') days?: string) {
    return this.superAdminService.getTokenUsage(days ? Math.max(1, parseInt(days, 10)) : 30);
  }
}
