import { IsString, IsEmail, IsOptional, IsNotEmpty, MaxLength, MinLength, Matches } from 'class-validator';
import { PASSWORD_REGEX, PASSWORD_VALIDATION_MESSAGE } from '../../../common/utils/password.util';

/**
 * DTO for submitting an access request (public, no auth needed).
 *
 * Public callers identify the target tenant by its `slug` or by its display
 * `newTenantName`, never by UUID: exposing tenant UUIDs to unauthenticated
 * traffic enables tenant enumeration. The server resolves slug/name → UUID
 * internally.
 */
export class CreateAccessRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  /** Slug of the existing tenant the requester wants to join. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, { message: 'tenantSlug must be lowercase alphanumeric with dashes' })
  tenantSlug?: string;

  /**
   * Organization name the user typed in the public form. Required.
   * Service layer matches this case-insensitively against existing tenants.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  newTenantName: string;
}

/**
 * DTO for approving an access request
 */
export class ApproveAccessRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_VALIDATION_MESSAGE })
  password?: string; // Optional: auto-generate if not provided
}

/**
 * Response shape for access requests
 */
export interface AccessRequestResponse {
  id: string;
  name: string;
  email: string;
  message: string | null;
  tenantId: string | null;
  tenantName: string | null;
  newTenantName: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}
