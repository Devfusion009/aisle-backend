/**
 * Application Configuration
 * Centralizes all environment variable access with type safety
 */
export default () => ({
  // Application
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  // PostgreSQL Database
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'aisle',
    password: process.env.DATABASE_PASSWORD || 'aisle_secret',
    name: process.env.DATABASE_NAME || 'aisle_db',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  // Qdrant Vector Database
  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: process.env.QDRANT_COLLECTION_NAME || 'documents',
  },

  // S3 / MinIO Object Storage
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    accessKey: process.env.S3_ACCESS_KEY || 'minio_admin',
    secretKey: process.env.S3_SECRET_KEY || 'minio_secret',
    bucket: process.env.S3_BUCKET || 'aisle-documents',
    region: process.env.S3_REGION || 'us-east-1',
  },

  // LLM Providers
  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    mistralApiKey: process.env.MISTRAL_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    defaultProvider: process.env.DEFAULT_LLM_PROVIDER || 'openai',
    defaultModel: process.env.DEFAULT_LLM_MODEL || 'gpt-4o-mini',
    defaultEmbeddingModel: process.env.DEFAULT_EMBEDDING_MODEL || 'text-embedding-3-small',
    /**
     * Ordered fallback chain used when the primary chat call fails with a transient
     * quota / credit / rate-limit error. Format: `provider:model, provider:model, ...`.
     * Defaults favor free-tier Gemini + Mistral so the service keeps answering even
     * when the user-selected model runs out of credits.
     */
    chatFallbackChain:
      process.env.LLM_FALLBACK_CHAIN ||
      'gemini:gemini-2.5-flash-lite,mistral:mistral-small-latest',
    /**
     * Ordered embedding fallback list. Only 1536-dim providers are safe — they must
     * match the Qdrant collection vector size. Auto-filtered by which API keys exist.
     */
    embeddingFallbackChain:
      process.env.EMBEDDING_FALLBACK_CHAIN || 'gemini,openai,openrouter',
  },

  // RAG Configuration
  rag: {
    chunkSize: parseInt(process.env.RAG_CHUNK_SIZE || '512', 10),
    chunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP || '50', 10),
    topK: parseInt(process.env.RAG_TOP_K || '5', 10),
  },
});
