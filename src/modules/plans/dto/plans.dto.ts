import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  IsBoolean,
  MaxLength,
  Matches,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  billingPeriod?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUsers?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAssistants?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDatasets?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxStorageBytes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyTokenLimit?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreatePlanDto extends UpdatePlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  // Codes feed into tenant.plan; restrict to lowercase alphanumerics + underscores
  // so they're URL-safe and stable.
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'code must contain only lowercase letters, numbers, and underscores',
  })
  code: string;
}

export class ConfigurePlansDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one plan tier is required.' })
  @ValidateNested({ each: true })
  @Type(() => CreatePlanDto)
  plans: CreatePlanDto[];
}
