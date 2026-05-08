import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// Configuration
import configuration from './config/configuration';

// Common
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { KbPermissionGuard } from './common/guards/kb-permission.guard';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

// Subscribers
import { ValidationSubscriber } from './database/subscribers/validation.subscriber';

// Entities
import { Tenant } from './database/entities/tenant.entity';
import { SubscriptionPlan } from './database/entities/subscription-plan.entity';
import { User } from './database/entities/user.entity';
import { Assistant } from './database/entities/assistant.entity';
import { Conversation } from './database/entities/conversation.entity';
import { Message } from './database/entities/message.entity';
import { Document } from './database/entities/document.entity';
import { DocumentChunk } from './database/entities/document-chunk.entity';
import { UsageLog } from './database/entities/usage-log.entity';
import { AccessRequest } from './database/entities/access-request.entity';
import { AssistantDataset } from './database/entities/assistant-dataset.entity';
import { ApiKey } from './database/entities/api-key.entity';
import { Webhook } from './database/entities/webhook.entity';
import { MessageVote } from './database/entities/message-vote.entity';
import { UserDatasetAccess } from './database/entities/user-dataset-access.entity';

// Modules
import { AuthModule } from './modules/auth/auth.module';
import { AssistantsModule } from './modules/assistants/assistants.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { VectorSearchModule } from './modules/vector-search/vector-search.module';
import { LlmGatewayModule } from './modules/llm-gateway/llm-gateway.module';
import { UsageModule } from './modules/usage/usage.module';
import { HealthController } from './health.controller';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { AccessRequestsModule } from './modules/access-requests/access-requests.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { PlansModule } from './modules/plans/plans.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { TenantUsersModule } from './modules/tenant-users/tenant-users.module';

/**
 * Root Application Module
 * 
 * This is the main module that ties together all the feature modules.
 * The application follows a modular monolith architecture for easy
 * future evolution into microservices.
 */
@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Database - PostgreSQL with TypeORM
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.name'),
        ssl: ['localhost', 'postgres'].includes(configService.get<string>('database.host') || '') ? false : { rejectUnauthorized: false },
        entities: [
          Tenant,
          SubscriptionPlan,
          User,
          Assistant,
          Conversation,
          Message,
          Document,
          DocumentChunk,
          UsageLog,
          AccessRequest,
          AssistantDataset,
          ApiKey,
          Webhook,
          MessageVote,
          UserDatasetAccess,
        ],
        subscribers: [ValidationSubscriber],
        synchronize: configService.get<string>('nodeEnv') !== 'production', // Auto-sync in dev only
        migrations: [__dirname + '/database/migrations/*.{ts,js}'],
        migrationsRun: true, // Auto-run pending migrations on every startup
        logging: configService.get<string>('nodeEnv') === 'development',
        timezone: 'Z', // Treat all DB timestamps as UTC
      }),
      inject: [ConfigService],
    }),

    // Rate limiting — protects every endpoint with a baseline throttle.
    // Auth-sensitive routes (login/refresh) override this with stricter
    // per-route @Throttle limits.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000, // 1 minute
        limit: 100,  // 100 req/min/IP — generous for normal app usage
      },
    ]),

    // JWT for global guard
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret') || 'default-secret',
        signOptions: {
          expiresIn: configService.get<string>('jwt.expiresIn') || '1d',
        },
      } as any),
      inject: [ConfigService],
    }),

    // Feature Modules
    AuthModule,
    AssistantsModule,
    ConversationsModule,
    KnowledgeModule,
    IngestionModule,
    VectorSearchModule,
    LlmGatewayModule,
    UsageModule,
    SuperAdminModule,
    AccessRequestsModule,
    TenantModule,
    DashboardModule,
    ApiKeysModule,
    WebhooksModule,
    PlansModule,
    TenantUsersModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global Rate-Limit Guard — runs before auth so brute-force traffic is
    // rejected without burning bcrypt / DB cycles.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global JWT Authentication Guard
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global Roles Guard (RBAC — exact roles + hierarchy)
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Global Permissions Guard (@RequirePermission)
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    // Global KB Permission Guard (@KbAccess) — per-dataset grants for regular users
    {
      provide: APP_GUARD,
      useClass: KbPermissionGuard,
    },
    // Global Exception Filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule { }
