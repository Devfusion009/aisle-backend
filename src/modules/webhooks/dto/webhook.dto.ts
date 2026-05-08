import { IsString, IsUrl, IsArray, IsOptional, MaxLength, MinLength } from 'class-validator';

export class CreateWebhookDto {
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsUrl() @MaxLength(1000) url: string;
  @IsArray() @IsString({ each: true }) events: string[];
}

export interface WebhookResponse {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  lastFiredAt: Date | null;
  createdAt: Date;
}
