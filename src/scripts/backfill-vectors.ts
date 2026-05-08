/**
 * Backfill Vectors
 *
 * Re-embeds every row in `document_chunks` using the current `EmbeddingService`
 * configuration and upserts the resulting vectors into Qdrant. Idempotent — can
 * be re-run safely; the point id is the chunk's `embeddingId` (generated if
 * missing) so existing points are overwritten in place.
 *
 * Usage:
 *   cd backend
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-vectors.ts
 *
 * Env vars honored: DATABASE_*, QDRANT_URL, QDRANT_COLLECTION_NAME,
 * GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, EMBEDDING_PROVIDER.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { DocumentChunk } from '../database/entities/document-chunk.entity';
import { Document } from '../database/entities/document.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { Assistant } from '../database/entities/assistant.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { Message } from '../database/entities/message.entity';
import { AssistantDataset } from '../database/entities/assistant-dataset.entity';
import { SubscriptionPlan } from '../database/entities/subscription-plan.entity';

dotenv.config();

const BATCH_SIZE = 20;
const EMBEDDING_DIM = 1536;

type Provider = 'gemini' | 'openai' | 'openrouter';

function pickProvider(): { provider: Provider; key: string } {
  const explicit = (process.env.EMBEDDING_PROVIDER || '').toLowerCase();
  const gemini = process.env.GEMINI_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  const openrouter = process.env.OPENROUTER_API_KEY;
  const valid = (k?: string, placeholder?: string) => !!k && k !== placeholder;

  if (explicit === 'gemini' && valid(gemini, 'your-gemini-api-key')) return { provider: 'gemini', key: gemini! };
  if (explicit === 'openai' && valid(openai, 'your-openai-api-key')) return { provider: 'openai', key: openai! };
  if (explicit === 'openrouter' && valid(openrouter, 'your-openrouter-api-key'))
    return { provider: 'openrouter', key: openrouter! };

  if (valid(gemini, 'your-gemini-api-key')) return { provider: 'gemini', key: gemini! };
  if (valid(openai, 'your-openai-api-key')) return { provider: 'openai', key: openai! };
  if (valid(openrouter, 'your-openrouter-api-key')) return { provider: 'openrouter', key: openrouter! };
  throw new Error('No embedding provider key configured (set GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY)');
}

async function embed(provider: Provider, key: string, texts: string[]): Promise<number[][]> {
  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${key}`;
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
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    return (json.embeddings || []).map((e: any) => e.values);
  }

  const baseURL = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
  const model = provider === 'openrouter' ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';
  const res = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  return json.data.map((d: any) => d.embedding);
}

async function main() {
  const { provider, key } = pickProvider();
  console.log(`[backfill] embedding provider: ${provider}`);

  const dbHost = process.env.DATABASE_HOST || 'localhost';
  // Mirror app.module.ts: SSL for any non-localhost host (RDS requires it). Override with
  // DATABASE_SSL=false for edge cases.
  const useSsl =
    process.env.DATABASE_SSL === 'false'
      ? false
      : !['localhost', 'postgres', '127.0.0.1'].includes(dbHost);
  const ds = new DataSource({
    type: 'postgres',
    host: dbHost,
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'aisle',
    password: process.env.DATABASE_PASSWORD || 'aisle_secret',
    database: process.env.DATABASE_NAME || 'aisle_db',
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    entities: [
      Tenant,
      User,
      Assistant,
      Conversation,
      Message,
      Document,
      DocumentChunk,
      AssistantDataset,
      SubscriptionPlan,
    ],
    synchronize: false,
  });
  await ds.initialize();
  console.log('[backfill] DB connected');

  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://localhost:6333' });
  const collection = process.env.QDRANT_COLLECTION_NAME || 'documents';

  const existing = await qdrant.getCollections();
  if (!existing.collections.some((c) => c.name === collection)) {
    await qdrant.createCollection(collection, { vectors: { size: EMBEDDING_DIM, distance: 'Cosine' } });
    await qdrant.createPayloadIndex(collection, { field_name: 'tenantId', field_schema: 'keyword' });
    await qdrant.createPayloadIndex(collection, { field_name: 'assistantId', field_schema: 'keyword' });
    console.log(`[backfill] created collection ${collection}`);
  }

  const chunkRepo = ds.getRepository(DocumentChunk);
  const docRepo = ds.getRepository(Document);

  const total = await chunkRepo.count();
  console.log(`[backfill] ${total} chunks to process`);
  if (total === 0) {
    await ds.destroy();
    return;
  }

  let processed = 0;
  let offset = 0;
  while (offset < total) {
    const chunks = await chunkRepo.find({
      order: { createdAt: 'ASC', id: 'ASC' },
      skip: offset,
      take: BATCH_SIZE,
    });
    if (chunks.length === 0) break;

    // Look up the parent document once per chunk to pull assistantId for the Qdrant payload.
    const docIds = Array.from(new Set(chunks.map((c) => c.documentId)));
    const docs = await docRepo.findByIds(docIds);
    const docMap = new Map(docs.map((d) => [d.id, d]));

    const texts = chunks.map((c) => c.content);
    const vectors = await embed(provider, key, texts);
    if (vectors.length !== chunks.length) {
      throw new Error(`got ${vectors.length} vectors for ${chunks.length} chunks`);
    }

    const points = chunks.map((c, i) => {
      const doc = docMap.get(c.documentId);
      const id = c.embeddingId || uuidv4();
      return {
        id,
        vector: vectors[i],
        payload: {
          tenantId: c.tenantId,
          assistantId: doc?.assistantId || null,
          documentId: c.documentId,
          chunkIndex: c.chunkIndex,
          content: c.content,
        },
        _chunkId: c.id,
        _embeddingId: id,
        _hadEmbeddingId: !!c.embeddingId,
      };
    });

    await qdrant.upsert(collection, {
      points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      wait: true,
    });

    // Persist any newly-generated embeddingIds back onto the chunk rows so the next
    // run stays idempotent and in sync with Qdrant.
    await Promise.all(
      points
        .filter((p) => !p._hadEmbeddingId)
        .map((p) => chunkRepo.update({ id: p._chunkId }, { embeddingId: p._embeddingId })),
    );

    processed += chunks.length;
    offset += chunks.length;
    console.log(`[backfill] ${processed}/${total} upserted`);
  }

  await ds.destroy();
  console.log('[backfill] done');
}

main().catch((err) => {
  console.error('[backfill] FAILED', err);
  process.exit(1);
});
