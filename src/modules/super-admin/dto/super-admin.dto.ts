import { IsString, IsEmail, IsEnum, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { UserRole } from '../../../common/interfaces/tenant-context.interface';

import { PASSWORD_REGEX, PASSWORD_VALIDATION_MESSAGE } from '../../../common/utils/password.util';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsString()
  @IsOptional()
  plan?: string;
}

export class UpdateTenantDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  name?: string;

  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @Matches(/^[a-z0-9][a-z0-9-]*$/i, {
    message: 'slug must contain only letters, numbers and hyphens',
  })
  slug?: string;

  @IsString()
  @IsOptional()
  plan?: string;
}

export class CreateUserBySuperAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_VALIDATION_MESSAGE })
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @IsOptional()
  tenantId?: string; // If optional, we might need a way to assign to "system" or let the service decide. Let's make it optional and if not provided, create a new tenant or fail? Actually, they want to link to existing or new tenant.

  // Instead of an optional tenantId, let's provide either tenantId or newTenant details.
  @IsOptional()
  newTenantName?: string;
  
  @IsOptional()
  newTenantSlug?: string;

  @IsString()
  @IsOptional()
  newTenantPlan?: string;
}
