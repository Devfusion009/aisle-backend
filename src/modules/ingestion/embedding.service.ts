import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { isRetriableQuotaError } from '../llm-gateway/is-retriable-error';

/**
 * Supported embedding providers. All must output 1536-dim vectors so they stay
 * drop-in compatible with the existing Qdrant collection (`size: 1536`).
 * - `gemini`     → Google `gemini-embedding-001` with outputDimensionality=1536 (free tier)
 * - `openai`     → `text-embedding-3-small` (1536 native)
 * - `openrouter` → routes `openai/text-embedding-3-small` (1536 native)
 */
type EmbeddingProvider = 'gemini' | 'openai' | 'openrouter';

const EMBEDDING_DIM = 1536;

interface ProviderHandle {
  name: EmbeddingProvider;
  embed: (texts: string[]) => Promise<number[][]>;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly chain: ProviderHandle[];

  constructor(private readonly configService: ConfigService) {
    const openaiKey = this.configService.get<string>('llm.openaiApiKey');
    const openrouterKey = this.configService.get<string>('llm.openrouterApiKey');
    const geminiKey = this.configService.get<string>('llm.geminiApiKey');

    const valid = (k?: string, placeholder?: string) => !!k && k !== placeholder;
    const hasGemini = valid(geminiKey, 'your-gemini-api-key');
    const hasOpenai = valid(openaiKey, 'your-openai-api-key');
    const hasOpenrouter = valid(openrouterKey, 'your-openrouter-api-key');

    // Resolve ordered chain from config, filtered to providers with valid keys.
    // Historical env var `EMBEDDING_PROVIDER` still pins the primary if set.
    const pinned = (process.env.EMBEDDING_PROVIDER || '').toLowerCase();
    const chainRaw =
      this.configService.get<string>('llm.embeddingFallbackChain') || 'gemini,openai,openrouter';
    const requested = (pinned ? [pinned, ...chainRaw.split(',')] : chainRaw.split(','))
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is EmbeddingProvider => s === 'gemini' || s === 'openai' || s === 'openrouter');

    const seen = new Set<EmbeddingProvider>();
    this.chain = [];
    for (const name of requested) {
      if (seen.has(name)) continue;
      if (name === 'gemini' && hasGemini) {
        this.chain.push({ name, embed: (t) => this.geminiBatchEmbed(t, geminiKey!) });
        seen.add(name);
      } else if (name === 'openai' && hasOpenai) {
        const client = new OpenAI({ apiKey: openaiKey });
        const model =
          this.configService.get<string>('llm.defaultEmbeddingModel') || 'text-embedding-3-small';
        this.chain.push({ name, embed: (t) => this.openaiBatchEmbed(t, client, model) });
        seen.add(name);
      } else if (name === 'openrouter' && hasOpenrouter) {
        const client = new OpenAI({ apiKey: openrouterKey, baseURL: 'https://openrouter.ai/api/v1' });
        this.chain.push({
          name,
          embed: (t) => this.openaiBatchEmbed(t, client, 'openai/text-embedding-3-small'),
        });
        seen.add(name);
      }
    }

    if (this.chain.length === 0) {
      this.logger.error('No valid embedding provider key configured. Embeddings will fail.');
    } else {
      this.logger.log(
        `EmbeddingService chain (1536-dim): ${this.chain.map((p) => p.name).join(' → ')}`,
      );
    }
  }

  /** Primary provider currently in use. Exposed for diagnostics/logging. */
  getProvider(): EmbeddingProvider | 'none' {
    return this.chain[0]?.name ?? 'none';
  }

  getEmbeddingDimension(): number {
    return EMBEDDING_DIM;
  }

  /**
   * Embed a batch of texts. Walks the provider chain on transient quota errors
   * so a single provider running out of credits does not fail the whole ingestion
   * or block RAG queries.
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.chain.length === 0) {
      throw new Error('No embedding provider is configured');
    }
    let lastError: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const { name, embed } = this.chain[i];
      try {
        const vectors = await embed(texts);
        if (i > 0) this.logger.warn(`Embeddings succeeded via fallback #${i}: ${name}`);
        return vectors;
      } catch (error) {
        lastError = error;
        const retriable = isRetriableQuotaError(error);
        const hasMore = i < this.chain.length - 1;
        if (retriable && hasMore) {
          const next = this.chain[i + 1].name;
          this.logger.warn(
            `Embedding provider ${name} hit quota/credit limit — falling back to ${next}. ` +
              `(${(error as any)?.message || error})`,
          );
          continue;
        }
        this.logger.error(`Embedding provider ${name} failed`, error);
        throw error;
      }
    }
    throw lastError;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  private async openaiBatchEmbed(texts: string[], client: OpenAI, model: string): Promise<number[][]> {
    const response = await client.embeddings.create({ model, input: texts });
    return response.data.map((item) => item.embedding);
  }

  /**
   * Gemini batch embedding via `batchEmbedContents`, pinned to 1536 output dims.
   * Ref: https://ai.google.dev/api/embeddings#method:-models.batchembedcontents
   */
  private async geminiBatchEmbed(texts: string[], apiKey: string): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${apiKey}`;
    const body = {
      requests: texts.map((t) => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: t }] },
        outputDimensionality: EMBEDDING_DIM,
      })),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(`Gemini embedding HTTP ${res.status}: ${errText.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    const json: any = await res.json();
    const embeddings: number[][] = (json.embeddings || []).map((e: any) => e.values as number[]);
    if (embeddings.length !== texts.length) {
      throw new Error(`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs`);
    }
    return embeddings;
  }
}
