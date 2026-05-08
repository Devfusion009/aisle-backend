import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmGatewayService } from './llm-gateway.service';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { PromptBuilderService } from './prompt-builder.service';
import { OcrService } from './ocr.service';

import { OpenRouterProvider } from './providers/openrouter.provider';
import { MistralProvider } from './providers/mistral.provider';
import { GeminiProvider } from './providers/gemini.provider';

/**
 * LLM Gateway Module
 * Abstracts multiple LLM providers behind a unified interface.
 */
@Module({
  imports: [ConfigModule],
  providers: [LlmGatewayService, OpenAIProvider, AnthropicProvider, OpenRouterProvider, MistralProvider, GeminiProvider, PromptBuilderService, OcrService],
  exports: [LlmGatewayService, PromptBuilderService, OcrService],
})
export class LlmGatewayModule {}
