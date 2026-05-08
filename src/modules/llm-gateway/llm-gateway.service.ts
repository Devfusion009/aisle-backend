import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { MistralProvider } from './providers/mistral.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './interfaces/llm-provider.interface';
import { LLMProvider as LLMProviderEnum } from '../../database/entities/assistant.entity';
import { isRetriableQuotaError } from './is-retriable-error';

export type { LLMMessage, LLMOptions, LLMResponse };

/** One rung of the fallback chain. */
interface FallbackRung {
  provider: string;
  model: string;
}

/**
 * LLM Gateway Service
 * Unified interface for calling different LLM providers.
 */
@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);
  private readonly providers: Map<string, LLMProvider> = new Map();
  private readonly defaultProvider: string;
  private readonly fallbackChain: FallbackRung[];

  constructor(
    private readonly configService: ConfigService,
    private readonly openaiProvider: OpenAIProvider,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly openrouterProvider: OpenRouterProvider,
    private readonly mistralProvider: MistralProvider,
    private readonly geminiProvider: GeminiProvider,
  ) {
    // Register providers
    this.providers.set('openai', openaiProvider);
    this.providers.set('anthropic', anthropicProvider);
    this.providers.set('openrouter', openrouterProvider);
    this.providers.set('mistral', mistralProvider);
    this.providers.set('gemini', geminiProvider);

    this.defaultProvider = this.configService.get<string>('llm.defaultProvider') || 'openai';
    this.fallbackChain = this.parseFallbackChain(
      this.configService.get<string>('llm.chatFallbackChain') || '',
    );
    if (this.fallbackChain.length > 0) {
      this.logger.log(
        `Chat fallback chain: ${this.fallbackChain.map((r) => `${r.provider}:${r.model}`).join(' → ')}`,
      );
    }
  }

  private parseFallbackChain(raw: string): FallbackRung[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [provider, ...rest] = entry.split(':');
        const model = rest.join(':').trim();
        return { provider: provider.trim(), model };
      })
      .filter((r) => {
        const p = this.providers.get(r.provider);
        return !!r.model && !!p && p.isAvailable();
      });
  }

  /**
   * Build the ordered list of (provider, model) attempts for a single chat call.
   * Primary is whatever the caller specified; rungs from the fallback chain that
   * re-use the same (provider, model) as the primary are skipped.
   */
  private buildAttemptList(primary: FallbackRung): FallbackRung[] {
    const attempts: FallbackRung[] = [primary];
    for (const rung of this.fallbackChain) {
      if (rung.provider === primary.provider && rung.model === primary.model) continue;
      if (attempts.some((a) => a.provider === rung.provider && a.model === rung.model)) continue;
      attempts.push(rung);
    }
    return attempts;
  }

  /**
   * Send chat request. Walks the fallback chain on transient quota/credit errors
   * so the service keeps answering even when the primary model runs out of tokens.
   */
  async chat(
    messages: LLMMessage[],
    options: {
      provider?: LLMProviderEnum | string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
    },
  ): Promise<LLMResponse> {
    const primaryProvider = String(options.provider || this.defaultProvider);
    if (!this.providers.has(primaryProvider)) {
      throw new BadRequestException(`Unknown LLM provider: ${primaryProvider}`);
    }
    if (!this.providers.get(primaryProvider)!.isAvailable()) {
      throw new BadRequestException(`LLM provider ${primaryProvider} is not configured`);
    }

    const attempts = this.buildAttemptList({
      provider: primaryProvider,
      model: options.model || this.getDefaultModel(primaryProvider),
    });

    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const { provider: name, model } = attempts[i];
      const provider = this.providers.get(name)!;
      const llmOptions: LLMOptions = {
        model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        topP: options.topP,
      };
      const startTime = Date.now();
      try {
        const response = await provider.chat(messages, llmOptions);
        const latencyMs = Date.now() - startTime;
        this.logger.log(
          `LLM call completed: provider=${name}, model=${response.model}, ` +
            `tokens=${response.usage.totalTokens}, latency=${latencyMs}ms` +
            (i > 0 ? ` (fallback #${i})` : ''),
        );
        return response;
      } catch (error) {
        lastError = error;
        const retriable = isRetriableQuotaError(error);
        const hasMore = i < attempts.length - 1;
        if (retriable && hasMore) {
          const next = attempts[i + 1];
          this.logger.warn(
            `LLM ${name}:${model} hit quota/credit limit — falling back to ${next.provider}:${next.model}. ` +
              `(${(error as any)?.message || error})`,
          );
          continue;
        }
        this.logger.error(`LLM call failed: provider=${name}, model=${model}`, error);
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Stream chat tokens. Uses the same fallback chain as `chat()`, but can only
   * fall back if the upstream provider errors BEFORE yielding the first chunk —
   * once a token has been emitted to the client we can't rewind.
   */
  async *chatStream(
    messages: LLMMessage[],
    options: {
      provider?: LLMProviderEnum | string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
    },
  ): AsyncIterable<string> {
    const primaryProvider = String(options.provider || this.defaultProvider);
    if (!this.providers.has(primaryProvider)) {
      throw new BadRequestException(`Unknown LLM provider: ${primaryProvider}`);
    }
    if (!this.providers.get(primaryProvider)!.isAvailable()) {
      throw new BadRequestException(`LLM provider ${primaryProvider} is not available`);
    }

    const attempts = this.buildAttemptList({
      provider: primaryProvider,
      model: options.model || this.getDefaultModel(primaryProvider),
    });

    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const { provider: name, model } = attempts[i];
      const provider = this.providers.get(name)!;
      const llmOptions: LLMOptions = {
        model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        topP: options.topP,
      };

      try {
        if (provider.chatStream) {
          const iterator = provider.chatStream(messages, llmOptions)[Symbol.asyncIterator]();
          // Advance to the first chunk manually so we can catch pre-stream errors
          // (auth/quota) and fall back before any bytes leave the server.
          const first = await iterator.next();
          if (i > 0) {
            this.logger.warn(`LLM stream using fallback #${i}: ${name}:${model}`);
          }
          if (!first.done) {
            yield first.value as string;
            while (true) {
              const n = await iterator.next();
              if (n.done) break;
              yield n.value as string;
            }
          }
          return;
        } else {
          const response = await provider.chat(messages, llmOptions);
          if (i > 0) this.logger.warn(`LLM (non-stream) using fallback #${i}: ${name}:${model}`);
          yield response.content;
          return;
        }
      } catch (error) {
        lastError = error;
        const retriable = isRetriableQuotaError(error);
        const hasMore = i < attempts.length - 1;
        if (retriable && hasMore) {
          const next = attempts[i + 1];
          this.logger.warn(
            `LLM stream ${name}:${model} hit quota/credit limit — falling back to ${next.provider}:${next.model}. ` +
              `(${(error as any)?.message || error})`,
          );
          continue;
        }
        this.logger.error(`LLM stream failed: provider=${name}, model=${model}`, error);
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Get default model for a provider
   */
  private getDefaultModel(provider: string): string {
    switch (provider) {
      case 'openai':
        return this.configService.get<string>('llm.defaultModel') || 'gpt-4o-mini';
      case 'anthropic':
        return 'claude-3-sonnet-20240229';
      case 'openrouter':
        return 'openai/gpt-4o-mini';
      case 'mistral':
        return 'mistral-small-latest';
      case 'gemini':
        return 'gemini-2.5-flash-lite';
      default:
        return 'gpt-4o-mini';
    }
  }

  /**
   * Get available providers
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.isAvailable())
      .map(([name]) => name);
  }

  /**
   * Count tokens in text using the appropriate provider
   */
  countTokens(text: string, provider?: string): number {
    const providerName = provider || this.defaultProvider;
    const p = this.providers.get(providerName);
    return p?.countTokens(text) || Math.ceil(text.length / 4);
  }
}
