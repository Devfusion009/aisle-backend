import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { RateLimitError } from 'openai';
import { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../interfaces/llm-provider.interface';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000; // 5s, 10s, 20s

/**
 * Gemini Provider
 * Uses Google's OpenAI-compatible endpoint so no extra SDK is required.
 * Includes exponential backoff for 429 rate-limit errors (free-tier: 15 RPM).
 */
@Injectable()
export class GeminiProvider implements LLMProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client: OpenAI;
  readonly name = 'gemini';

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: this.configService.get<string>('llm.geminiApiKey'),
      maxRetries: 0, // We handle retries ourselves
    });
  }

  isAvailable(): boolean {
    return !!this.configService.get<string>('llm.geminiApiKey');
  }

  async chat(messages: LLMMessage[], options: LLMOptions): Promise<LLMResponse> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: options.model || 'gemini-2.5-flash-lite',
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 2048,
          top_p: options.topP ?? 1,
        });

        const choice = response.choices[0];
        return {
          content: choice.message.content || '',
          model: response.model,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
          },
          finishReason: this.mapFinishReason(choice.finish_reason),
        };
      } catch (error) {
        if (error instanceof RateLimitError && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn(`Gemini rate limited. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error('Gemini API call failed', error);
        throw error;
      }
    }
    throw new Error('Gemini chat failed after max retries');
  }

  async *chatStream(messages: LLMMessage[], options: LLMOptions): AsyncIterable<string> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = await this.client.chat.completions.create({
          model: options.model || 'gemini-2.5-flash-lite',
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 2048,
          stream: true,
        });

        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content;
          if (token) yield token;
        }
        return; // Success — exit retry loop
      } catch (error) {
        if (error instanceof RateLimitError && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn(`Gemini stream rate limited. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error('Gemini stream failed', error);
        throw error;
      }
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }
}
