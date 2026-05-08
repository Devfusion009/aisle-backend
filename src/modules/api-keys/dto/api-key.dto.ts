import { IsString, IsOptional, MaxLength, MinLength, IsArray } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** LLM provider, e.g. 'openai', 'anthropic' */
  @IsString()
  @MaxLength(50)
  provider: string;

  /** Model identifier, e.g. 'gpt-4o-mini' */
  @IsString()
  @MaxLength(100)
  model: string;

  /** Optional system prompt for the bot */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  systemPrompt?: string;

  /** Assistant UUIDs whose knowledge base this key can RAG against */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  authorizedAssistantIds?: string[];
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  provider: string;
  model: string;
  systemPrompt: string | null;
  authorizedAssistantIds: string[];
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Returned only on creation — includes the full plaintext key (shown once) */
export interface ApiKeyCreatedResponse extends ApiKeyResponse {
  fullKey: string;
}
