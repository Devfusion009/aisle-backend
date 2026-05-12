import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotency guard: if the tenants table already exists the initial schema
    // was set up via init-db.sql or an earlier synchronize run. Skip to avoid
    // "already exists" errors on existing production databases.
    const tablesExist = await queryRunner.hasTable('tenants');
    if (tablesExist) return;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE users_role_enum AS ENUM (
        'platform_admin', 'tenant_owner', 'tenant_admin', 'editor', 'user'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE assistants_provider_enum AS ENUM (
        'openai', 'anthropic', 'openrouter', 'mistral', 'gemini'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE messages_role_enum AS ENUM (
        'system', 'user', 'assistant'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE documents_status_enum AS ENUM (
        'pending', 'processing', 'completed', 'failed'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE access_requests_status_enum AS ENUM (
        'pending', 'approved', 'rejected'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE users_priority_enum AS ENUM (
        'high', 'low'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN CREATE TYPE tenants_plan_enum AS ENUM (
        'starter', 'business', 'enterprise'
      ); EXCEPTION WHEN duplicate_object THEN null; END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        plan tenants_plan_enum NOT NULL DEFAULT 'starter',
        settings JSONB,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        "passwordHash" VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role users_role_enum NOT NULL DEFAULT 'user',
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "lastLoginAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users ("tenantId", email)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users ("tenantId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS assistants (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        "systemPrompt" TEXT NOT NULL,
        provider assistants_provider_enum NOT NULL DEFAULT 'openrouter',
        model VARCHAR(100) NOT NULL DEFAULT 'openai/gpt-4o-mini',
        temperature DECIMAL(3, 2) NOT NULL DEFAULT 0.7,
        "maxTokens" INTEGER NOT NULL DEFAULT 2048,
        "ragEnabled" BOOLEAN NOT NULL DEFAULT true,
        "ragTopK" INTEGER NOT NULL DEFAULT 5,
        "isDataset" BOOLEAN NOT NULL DEFAULT false,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_assistants_tenant ON assistants ("tenantId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "assistantId" UUID REFERENCES assistants(id) ON DELETE SET NULL,
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255),
        summary TEXT,
        "totalTokensUsed" INTEGER NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "isPinned" BOOLEAN NOT NULL DEFAULT false,
        "isArchived" BOOLEAN NOT NULL DEFAULT false,
        "isDeletedByUser" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tenant_assistant ON conversations ("tenantId", "assistantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user ON conversations ("tenantId", "userId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role messages_role_enum NOT NULL,
        content TEXT NOT NULL,
        "tokensUsed" INTEGER NOT NULL DEFAULT 0,
        "contextChunks" JSONB,
        model VARCHAR(100),
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_messages_tenant_conversation ON messages ("tenantId", "conversationId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "assistantId" UUID REFERENCES assistants(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        "s3Key" VARCHAR(500) NOT NULL,
        "mimeType" VARCHAR(100) NOT NULL,
        "fileSize" BIGINT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status documents_status_enum NOT NULL DEFAULT 'pending',
        "errorMessage" TEXT,
        "chunkCount" INTEGER NOT NULL DEFAULT 0,
        "characterCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_documents_tenant_assistant ON documents ("tenantId", "assistantId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "documentId" UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        "chunkIndex" INTEGER NOT NULL,
        "startOffset" INTEGER NOT NULL,
        "endOffset" INTEGER NOT NULL,
        "tokenCount" INTEGER NOT NULL DEFAULT 0,
        "embeddingId" UUID,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant ON document_chunks ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_document ON document_chunks ("tenantId", "documentId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "assistantId" UUID REFERENCES assistants(id) ON DELETE SET NULL,
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "conversationId" UUID,
        "tokensInput" INTEGER NOT NULL,
        "tokensOutput" INTEGER NOT NULL,
        "tokensTotal" INTEGER NOT NULL,
        model VARCHAR(100) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        "latencyMs" INTEGER,
        success BOOLEAN NOT NULL DEFAULT true,
        "errorMessage" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant ON usage_logs ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_assistant ON usage_logs ("tenantId", "assistantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_date ON usage_logs ("tenantId", "createdAt")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        message TEXT,
        "tenantId" UUID REFERENCES tenants(id) ON DELETE SET NULL,
        "newTenantName" VARCHAR(255),
        status access_requests_status_enum NOT NULL DEFAULT 'pending',
        "reviewedBy" UUID,
        "reviewedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests (email)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS assistant_datasets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "assistantId" UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
        "datasetId" UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_datasets_unique ON assistant_datasets ("assistantId", "datasetId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_assistant_datasets_assistant ON assistant_datasets ("assistantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_assistant_datasets_tenant ON assistant_datasets ("tenantId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_dataset_access (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "datasetId" UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "grantedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_dataset_access_unique ON user_dataset_access ("userId", "datasetId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_dataset_access_tenant_user ON user_dataset_access ("tenantId", "userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_dataset_access_tenant_dataset ON user_dataset_access ("tenantId", "datasetId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_dataset_access CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS assistant_datasets CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS access_requests CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS usage_logs CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_chunks CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS documents CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS messages CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS conversations CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS assistants CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS users CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS tenants CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS tenants_plan_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS users_priority_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS access_requests_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS documents_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS messages_role_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS assistants_provider_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS users_role_enum`);
  }
}
