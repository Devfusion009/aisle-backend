import {
  IsEmail,
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  IsUUID,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { UserRole } from '../../../common/interfaces/tenant-context.interface';
import { UserPriority } from '../../../database/entities/user.entity';
import {
  PASSWORD_REGEX,
  PASSWORD_VALIDATION_MESSAGE,
} from '../../../common/utils/password.util';

export class CreateTenantUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_VALIDATION_MESSAGE })
  password: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserPriority)
  priority?: UserPriority;
}

export class UpdateTenantUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserPriority)
  priority?: UserPriority;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetDatasetAccessDto {
  @IsArray()
  @IsUUID('4', { each: true })
  datasetIds: string[];
}
