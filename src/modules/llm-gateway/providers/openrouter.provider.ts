import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../interfaces/llm-provider.interface';

/**
 * OpenRouter Provider
 * Implementation of LLMProvider for OpenRouter models.
 */
@Injectable()
export class OpenRouterProvider implements LLMProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);
  private readonly client: OpenAI;
  readonly name = 'openrouter';

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: this.configService.get<string>('llm.openrouterApiKey'),
    });
  }

  isAvailable(): boolean {
    return !!this.configService.get<string>('llm.openrouterApiKey');
  }

  async chat(messages: LLMMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model || 'openai/gpt-4o-mini',
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2048,
        top_p: options.topP ?? 1,
        stop: options.stop,
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
      this.logger.error('OpenRouter API call failed', error);
      throw error;
    }
  }

  async *chatStream(messages: LLMMessage[], options: LLMOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: options.model || 'openai/gpt-4o-mini',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}
