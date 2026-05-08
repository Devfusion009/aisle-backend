import {
  IsString,
  IsUUID,
  IsOptional,
  MaxLength,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A single inline image attached to a chat message. `dataBase64` is the raw
 * base64 payload with no `data:` URI prefix — the frontend strips the prefix
 * before sending.
 *
 * Size cap: ~6.7 MB base64 ≈ 5 MB binary per image. Combined with
 * `@ArrayMaxSize(3)` and the 20 MB JSON body limit in main.ts this keeps the
 * worst-case request well under the limit.
 */
export class ChatImageDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsString()
  @Matches(/^image\/(png|jpe?g|webp|gif|bmp|tiff|heic|heif)$/i, {
    message: 'Unsupported image type',
  })
  mimeType: string;

  @IsString()
  @MaxLength(6_700_000)
  dataBase64: string;
}

/**
 * DTO for creating a new conversation
 */
export class CreateConversationDto {
  @IsUUID()
  assistantId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

/**
 * DTO for updating an existing conversation
 */
export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

/**
 * DTO for sending a chat message
 * Optional parameter overrides (used by Playground) take precedence over assistant defaults.
 */
export class ChatMessageDto {
  @IsString()
  @MaxLength(32000)
  message: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(128000)
  maxTokens?: number;

  /** Override provider when falling back to an alternate model */
  @IsOptional()
  @IsString()
  fallbackProvider?: string;

  /** Override model when falling back to an alternate model */
  @IsOptional()
  @IsString()
  fallbackModel?: string;

  /** Skip re-saving the user message (already saved by the first failed attempt) */
  @IsOptional()
  isRetry?: boolean;

  /**
   * Up to 3 inline images. The backend OCRs each one with Gemini multimodal
   * and appends the extracted text to the user message before running RAG
   * and calling the LLM.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'A maximum of 3 images per message is allowed' })
  @ValidateNested({ each: true })
  @Type(() => ChatImageDto)
  images?: ChatImageDto[];
}

/**
 * Conversation response DTO
 */
export interface ConversationResponse {
  id: string;
  assistantId: string;
  assistantName: string;
  userId: string;
  title: string | null;
  totalTokensUsed: number;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: Date;
}

/**
 * DTO for voting on a message
 */
export class VoteMessageDto {
  @IsEnum(['up', 'down', null])
  vote: 'up' | 'down' | null;
}

/**
 * Message response DTO
 */
export interface MessageResponse {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokensUsed: number;
  model: string | null;
  vote: 'up' | 'down' | null;
  createdAt: Date;
  /** Image attachments uploaded with a user message (absent for text-only turns) */
  attachments?: { name: string; mimeType: string; dataUrl: string }[];
}

/**
 * Chat response DTO
 */
export interface ChatResponse {
  message: MessageResponse;
  conversationId: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  contextChunks?: {
    documentId: string;
    content: string;
    score: number;
  }[];
}
