import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsEnum, Matches } from 'class-validator';
import { UserRole } from '../../../common/interfaces/tenant-context.interface';
import { PASSWORD_REGEX, PASSWORD_VALIDATION_MESSAGE } from '../../../common/utils/password.util';

/**
 * DTO for user registration
 */
export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_VALIDATION_MESSAGE })
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  /** Tenant slug - if not provided, creates a new tenant */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;

  /** Tenant name - required when creating new tenant */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  tenantName?: string;
}

/**
 * DTO for user login
 */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  /** Tenant slug for multi-tenant login (optional - if not provided, finds user by email) */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;
}

/**
 * DTO for refresh token
 */
export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}

/**
 * Auth response with tokens
 */
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    priority?: string;
    tenantId: string;
    tenantName: string;
    profilePhotoUrl?: string | null;
  };
}
