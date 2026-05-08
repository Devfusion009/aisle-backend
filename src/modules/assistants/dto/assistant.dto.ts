import { IsString, IsOptional, IsBoolean, IsNumber, Min, Max, IsEnum, MaxLength } from 'class-validator';
import { LLMProvider } from '../../../database/entities/assistant.entity';

/**
 * DTO for creating a new assistant
 */
export class CreateAssistantDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @MaxLength(10000)
  systemPrompt: string;

  @IsOptional()
  @IsEnum(LLMProvider)
  provider?: LLMProvider;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Max(16000)
  maxTokens?: number;

  @IsOptional()
  @IsBoolean()
  ragEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  ragTopK?: number;
}

/**
 * DTO for updating an assistant
 */
export class UpdateAssistantDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  systemPrompt?: string;

  @IsOptional()
  @IsEnum(LLMProvider)
  provider?: LLMProvider;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Max(16000)
  maxTokens?: number;

  @IsOptional()
  @IsBoolean()
  ragEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  ragTopK?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * DTO for creating a knowledge-base dataset folder
 */
export class CreateDatasetDto {
  @IsString()
  @MaxLength(255)
  name: string;
}

/**
 * DTO for renaming a dataset
 */
export class RenameDatasetDto {
  @IsString()
  @MaxLength(255)
  name: string;
}

/**
 * Dataset (knowledge-base folder) response
 */
export interface DatasetResponse {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Assistant response DTO
 */
export interface AssistantResponse {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  ragEnabled: boolean;
  ragTopK: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  conversationCount?: number;
  datasetCount?: number;
  linkedDatasets?: { id: string; name: string }[];
}
