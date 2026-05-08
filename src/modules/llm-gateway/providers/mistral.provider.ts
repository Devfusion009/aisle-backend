import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../interfaces/llm-provider.interface';

/**
 * Mistral Provider
 * Implementation of LLMProvider for Mistral models using OpenAI compatibility wrapper.
 */
@Injectable()
export class MistralProvider implements LLMProvider {
  private readonly logger = new Logger(MistralProvider.name);
  private readonly client: OpenAI;
  readonly name = 'mistral';

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('llm.mistralApiKey') || 'missing',
      baseURL: 'https://api.mistral.ai/v1',
    });
  }

  isAvailable(): boolean {
    const key = this.configService.get<string>('llm.mistralApiKey');
    return !!key && key !== 'missing';
  }

  async chat(messages: LLMMessage[], options: LLMOptions): Promise<LLMResponse> {
    let params: any = {};
    try {
      params = {
        model: options.model || 'mistral-small-latest',
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content as string,
        })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2048,
        top_p: options.topP ?? 1,
      };

      if (options.stop && options.stop.length > 0) {
        params.stop = options.stop;
      }

      const response = await this.client.chat.completions.create(params);

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
    } catch (error: any) {
      if (error.response || error.error) {
        this.logger.error('Mistral API call failed with response', JSON.stringify(error.response?.data || error.error));
      } else {
        this.logger.error('Mistral API call failed', error);
      }
      try {
        const fs = require('fs');
        fs.writeFileSync('/home/gourav/Desktop/Aisle/mistral_err.txt', JSON.stringify({
          params,
          error: error.response?.data || error.error || error.message
        }, null, 2));
      } catch (e) {}
      throw error;
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
