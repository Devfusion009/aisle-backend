import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MessageRole } from '../../database/entities/message.entity';

/**
 * Session state stored in Redis
 */
export interface SessionState {
  conversationId: string;
  tenantId: string;
  assistantId: string;
  userId: string;
  /** Recent message history for context (limited for performance) */
  recentMessages: SessionMessage[];
  /** Last activity timestamp */
  lastActivity: number;
  /** Conversation summary for long contexts */
  summary?: string;
}

export interface SessionMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
}

/**
 * Session Service
 * Manages conversation state in Redis for fast access during chat.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly redis: Redis;
  private readonly sessionTtl: number = 3600; // 1 hour
  private readonly maxRecentMessages: number = 10;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('redis.host');
    const port = this.configService.get<number>('redis.port');
    const tlsEnv = (process.env.REDIS_TLS ?? '').toLowerCase();
    const useTls = tlsEnv
      ? tlsEnv === 'true' || tlsEnv === '1'
      : !!host?.includes('cache.amazonaws.com');

    this.redis = new Redis({
      host,
      port,
      ...(useTls ? { tls: {} } : {})
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });
  }

  /**
   * Get session key for Redis
   */
  private getSessionKey(conversationId: string): string {
    return `session:${conversationId}`;
  }

  /**
   * Get or create session state for a conversation
   */
  async getSession(conversationId: string): Promise<SessionState | null> {
    const key = this.getSessionKey(conversationId);
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as SessionState;
    } catch (error) {
      this.logger.warn(`Failed to parse session data for ${conversationId}`);
      return null;
    }
  }

  /**
   * Create a new session
   */
  async createSession(session: SessionState): Promise<void> {
    const key = this.getSessionKey(session.conversationId);
    await this.redis.setex(key, this.sessionTtl, JSON.stringify(session));
  }

  /**
   * Update session with new message
   */
  async addMessage(conversationId: string, message: SessionMessage): Promise<void> {
    const session = await this.getSession(conversationId);
    if (!session) {
      this.logger.warn(`Session not found for ${conversationId}`);
      return;
    }

    // Add message and trim to max recent messages
    session.recentMessages.push(message);
    if (session.recentMessages.length > this.maxRecentMessages) {
      session.recentMessages = session.recentMessages.slice(-this.maxRecentMessages);
    }

    session.lastActivity = Date.now();

    const key = this.getSessionKey(conversationId);
    await this.redis.setex(key, this.sessionTtl, JSON.stringify(session));
  }

  /**
   * Update session summary
   */
  async updateSummary(conversationId: string, summary: string): Promise<void> {
    const session = await this.getSession(conversationId);
    if (!session) {
      return;
    }

    session.summary = summary;
    session.lastActivity = Date.now();

    const key = this.getSessionKey(conversationId);
    await this.redis.setex(key, this.sessionTtl, JSON.stringify(session));
  }

  /**
   * Delete session
   */
  async deleteSession(conversationId: string): Promise<void> {
    const key = this.getSessionKey(conversationId);
    await this.redis.del(key);
  }

  /**
   * Refresh session TTL
   */
  async refreshSession(conversationId: string): Promise<void> {
    const key = this.getSessionKey(conversationId);
    await this.redis.expire(key, this.sessionTtl);
  }
}
