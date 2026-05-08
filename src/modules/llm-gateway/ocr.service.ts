import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { isRetriableQuotaError } from './is-retriable-error';

/**
 * Image payload accepted by OcrService. `dataBase64` must be the raw base64
 * payload with no `data:` URI prefix.
 */
export interface OcrImage {
  mimeType: string;
  dataBase64: string;
  filename?: string;
}

export interface OcrResult {
  filename?: string;
  text: string;
  /** Provider that actually produced the text (for debugging / logs) */
  providerUsed?: string;
  /** True when the result was served from Redis without hitting any provider */
  cached?: boolean;
  failed?: boolean;
  error?: string;
}

const OCR_PROMPT =
  'You are a strict OCR engine. Extract ALL text visible in this image verbatim — ' +
  'including handwriting, tables, signs, labels, diagrams, watermarks, captions, and ' +
  'any non-Latin scripts (Tamil, Hindi, Arabic, Chinese, Japanese, etc.). ' +
  'Preserve meaningful line breaks. ' +
  'Do NOT translate, summarise, describe non-text content, or add commentary. ' +
  'If the image contains absolutely no text, respond with the single word: NONE';

/**
 * Per-provider hard timeout. If a provider doesn't respond within this window
 * we abort and move to the next one. The default Node `fetch` has no timeout,
 * which is how a flaky provider stalls a chat for 30+ seconds.
 *
 * 12s covers Nemotron-VL cold starts (measured ~10s end-to-end on the first
 * hit of the day, 3-5s after that) and Flash-class models (p50 ≈ 1-2s). If
 * all 5 providers hit the timeout we still come back in ~60s total, which
 * is below any reasonable HTTP client timeout on the frontend.
 */
const PROVIDER_TIMEOUT_MS = 12_000;

/**
 * How long to remember an OCR result keyed on the sha256 of the image bytes.
 * 7 days is long enough that a user scrolling back to an old conversation
 * doesn't pay for OCR again, short enough that stale results can't grow
 * unboundedly in Redis.
 */
const OCR_CACHE_TTL_SECONDS = 7 * 24 * 3600;

type ProviderName =
  | 'openrouter-nemotron-vl'
  | 'openrouter-gemma-3-27b'
  | 'openrouter-gemma-3-12b'
  | 'gemini-flash-lite'
  | 'mistral-pixtral';

type ProviderImpl = (image: OcrImage, signal: AbortSignal) => Promise<string>;

/**
 * OpenRouter free vision models we cycle through, best-first. Order is
 * based on hands-on testing 2026-04-17:
 *  - nemotron-nano-12b-v2-vl:free → reliably available, dedicated vision
 *  - gemma-3-27b-it:free          → strongest quality when not 429'd
 *  - gemma-3-12b-it:free          → smaller but frequently available when 27b is not
 *
 * `google/gemini-2.0-flash-exp:free` is DEAD (404 — retired by OpenRouter).
 * Do not add back without testing.
 */

/**
 * Rolling circuit-breaker: after a provider returns a retriable error (429 /
 * quota / auth), we skip it for a short cooldown window on subsequent calls.
 * This is what makes follow-up turns feel instant — we don't pay the 2-3s
 * roundtrip to Gemini just to learn it's still rate-limited.
 */
const CIRCUIT_COOLDOWN_MS = 30_000;

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly chain: { name: ProviderName; run: ProviderImpl }[] = [];
  private readonly redis: Redis;
  private readonly openUntil = new Map<ProviderName, number>();

  constructor(private readonly configService: ConfigService) {
    const gemini = this.configService.get<string>('llm.geminiApiKey');
    const openrouter = this.configService.get<string>('llm.openrouterApiKey');
    const mistral = this.configService.get<string>('llm.mistralApiKey');

    // Order matters. Each tier lives in a *different* quota pool than the one
    // above it, so when Google's 20 rpm free tier is saturated we can still
    // serve OCR via Nvidia or Mistral. Before changing this chain, test each
    // model with `python3 /tmp/test-ocr.py` against a real image — we've
    // already lost a production day to OpenRouter silently retiring a model.
    if (isUsableKey(openrouter)) {
      // Primary: Nvidia's dedicated vision model on OpenRouter free tier.
      // Independent infra from Google, so rarely 429s at the same time.
      this.chain.push({
        name: 'openrouter-nemotron-vl',
        run: (img, signal) =>
          this.runOpenRouter(img, openrouter!, 'nvidia/nemotron-nano-12b-v2-vl:free', signal),
      });
      // Secondary: Gemma 3 27b — best quality when Google AI Studio has
      // headroom. Shares a pool with the direct Gemini call below.
      this.chain.push({
        name: 'openrouter-gemma-3-27b',
        run: (img, signal) =>
          this.runOpenRouter(img, openrouter!, 'google/gemma-3-27b-it:free', signal),
      });
      // Tertiary: Gemma 3 12b — smaller sibling that sometimes has capacity
      // when 27b is locked out.
      this.chain.push({
        name: 'openrouter-gemma-3-12b',
        run: (img, signal) =>
          this.runOpenRouter(img, openrouter!, 'google/gemma-3-12b-it:free', signal),
      });
    }
    if (isUsableKey(gemini)) {
      // Quaternary: Google's direct Gemini API. Only 20 rpm on the free tier
      // so it saturates fast, but it's on a separate account from the
      // OpenRouter pool above so it comes back online independently.
      this.chain.push({
        name: 'gemini-flash-lite',
        run: (img, signal) => this.runGemini(img, gemini!, signal),
      });
    }
    if (isUsableKey(mistral)) {
      // Last resort: Mistral Pixtral — weakest on handwriting / non-Latin
      // scripts but has its own quota pool unrelated to the four above.
      this.chain.push({
        name: 'mistral-pixtral',
        run: (img, signal) => this.runMistral(img, mistral!, signal),
      });
    }

    const host = this.configService.get<string>('redis.host');
    const port = this.configService.get<number>('redis.port');
    const tlsEnv = (process.env.REDIS_TLS ?? '').toLowerCase();
    const useTls = tlsEnv
      ? tlsEnv === 'true' || tlsEnv === '1'
      : !!host?.includes('cache.amazonaws.com');
    this.redis = new Redis({ host, port, ...(useTls ? { tls: {} } : {}) });
    this.redis.on('error', (err) => this.logger.warn(`OCR cache Redis error: ${err.message}`));

    if (this.chain.length === 0) {
      this.logger.warn('OcrService disabled: no vision-capable API keys configured');
    } else {
      this.logger.log(
        `OcrService ready with fallback chain: ${this.chain.map((p) => p.name).join(' → ')}`,
      );
    }
  }

  isAvailable(): boolean {
    return this.chain.length > 0;
  }

  /**
   * Extract text from a single image, walking the provider chain on any
   * retriable (quota / 4xx) error. Respects per-provider circuit breakers
   * and a hard per-provider timeout so one sluggish provider can't stall
   * the whole request.
   *
   * Throws only when every provider fails — callers should prefer
   * `extractTextBatch` which catches per-image.
   */
  async extractText(image: OcrImage): Promise<{ text: string; providerUsed: string }> {
    if (this.chain.length === 0) {
      throw new Error('OCR unavailable: no vision-capable API keys configured');
    }

    const now = Date.now();
    // Try every non-broken provider. If ALL are in their cooldown window
    // we still attempt them — better to retry than bail.
    const active = this.chain.filter((p) => (this.openUntil.get(p.name) ?? 0) <= now);
    const order = active.length > 0 ? active : this.chain;

    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
      const { name, run } = order[i];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
      try {
        const text = await run(image, controller.signal);
        clearTimeout(timer);
        if (i > 0) {
          this.logger.warn(
            `OCR succeeded via fallback #${i} (${name}) for ${image.filename || '[unnamed]'}`,
          );
        }
        return { text, providerUsed: name };
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        const retriable = isRetriableQuotaError(error) || isTimeoutError(error);
        if (retriable) {
          // Open the circuit for this provider so future calls skip it.
          this.openUntil.set(name, Date.now() + CIRCUIT_COOLDOWN_MS);
        }
        const hasMore = i < order.length - 1;
        const msg = error instanceof Error ? error.message : String(error);
        if (retriable && hasMore) {
          this.logger.warn(
            `OCR provider ${name} failed (${msg.slice(0, 160)}) — trying next`,
          );
          continue;
        }
        this.logger.error(`OCR provider ${name} failed: ${msg}`);
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Run OCR on every image in parallel, caching on sha256 of the image
   * bytes. Catches per-image so one bad image never takes down the whole
   * message turn.
   */
  async extractTextBatch(images: OcrImage[]): Promise<OcrResult[]> {
    return Promise.all(images.map((img) => this.extractOneCached(img)));
  }

  private async extractOneCached(img: OcrImage): Promise<OcrResult> {
    // SHA-256 over the raw base64 payload + mime type is stable across
    // tenants and conversations, so users who upload the same meme twice
    // never pay for OCR twice.
    const digest = createHash('sha256')
      .update(img.mimeType)
      .update('|')
      .update(img.dataBase64)
      .digest('hex');
    const cacheKey = `ocr:v1:${digest}`;

    // Read-through
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return {
          filename: img.filename,
          text: cached,
          providerUsed: 'cache',
          cached: true,
        };
      }
    } catch (err) {
      // Cache down — fall through to live OCR, don't fail the turn.
      this.logger.warn(
        `OCR cache read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const { text, providerUsed } = await this.extractText(img);
      // Write-back, don't block the response on a slow Redis.
      this.redis
        .setex(cacheKey, OCR_CACHE_TTL_SECONDS, text)
        .catch((err) =>
          this.logger.warn(
            `OCR cache write failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return { filename: img.filename, text, providerUsed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OCR failed for ${img.filename || '[unnamed]'}: ${message}`);
      return { filename: img.filename, text: '', failed: true, error: message };
    }
  }

  // ──────────────────────── provider implementations ────────────────────────

  /**
   * Google Gemini 2.5 Flash-Lite — purpose-built for high-volume, low-latency
   * multimodal inference. 2-3x faster than plain Flash with negligible OCR
   * quality loss on printed + handwritten text.
   */
  private async runGemini(
    image: OcrImage,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    const body = {
      contents: [
        {
          parts: [
            { text: OCR_PROMPT },
            { inline_data: { mime_type: image.mimeType, data: image.dataBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 2048 },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw buildHttpError('Gemini OCR', res.status, errText);
    }
    const json: any = await res.json();
    const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return normaliseOcrText(text);
  }

  /**
   * OpenRouter chat-completions with a caller-specified vision model. We
   * parameterise the model so the provider chain can cycle through several
   * free-tier vision models without duplicating the HTTP plumbing.
   */
  private async runOpenRouter(
    image: OcrImage,
    apiKey: string,
    model: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const body = {
      model,
      max_tokens: 2048,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
            },
          ],
        },
      ],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://aisle.app',
        'X-Title': 'Aisle OCR',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw buildHttpError(`OpenRouter OCR [${model}]`, res.status, errText);
    }
    const json: any = await res.json();
    // OpenRouter returns upstream 4xx as 200 with an `error` field for some
    // models (e.g. gemma-3-27b-it:free returning 429 from Google AI Studio).
    // Surface those as throwables so our circuit breaker can mark the model
    // as retriable and move on instead of treating the response as success.
    if (json?.error) {
      const upstream = json.error?.metadata?.raw || json.error?.message || 'unknown OpenRouter error';
      const code = json.error?.code ?? 502;
      throw buildHttpError(`OpenRouter OCR [${model}]`, code, upstream);
    }
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    return normaliseOcrText(text);
  }

  /** Mistral Pixtral — weaker on handwriting but a useful last resort. */
  private async runMistral(
    image: OcrImage,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = 'https://api.mistral.ai/v1/chat/completions';
    const body = {
      model: 'pixtral-12b-2409',
      max_tokens: 2048,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            {
              type: 'image_url',
              image_url: `data:${image.mimeType};base64,${image.dataBase64}`,
            },
          ],
        },
      ],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw buildHttpError('Mistral OCR', res.status, errText);
    }
    const json: any = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    return normaliseOcrText(text);
  }
}

function isUsableKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  return !/^your-.*-api-key$/i.test(trimmed);
}

function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const e = err as any;
  if (e.name === 'AbortError') return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out');
}

function buildHttpError(prefix: string, status: number, errText: string): Error {
  const err = new Error(`${prefix} HTTP ${status}: ${errText.slice(0, 400)}`) as Error & {
    status: number;
  };
  err.status = status;
  return err;
}

function normaliseOcrText(raw: string): string {
  const trimmed = (raw || '').trim();
  return trimmed.toUpperCase() === 'NONE' ? '' : trimmed;
}
