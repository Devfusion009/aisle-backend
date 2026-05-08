import {
  Controller, Post, Get, Body, Headers, Param, UnauthorizedException, Res, NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { ApiKeysService } from './api-keys.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import { LlmGatewayService, LLMMessage } from '../llm-gateway/llm-gateway.service';
import { SessionService } from '../conversations/session.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessageRole } from '../../database/entities/message.entity';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

class PublicChatDto {
  @IsString()
  @MaxLength(32000)
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string; // omit to start a new session
}

/**
 * Public API Controller
 * Authenticated via X-API-Key header — used by external bots (WhatsApp, Telegram, etc.)
 * Uses the model + systemPrompt + authorizedAssistantIds stored on the API key — no assistantId needed.
 */
@Controller('public')
@Public()
export class PublicApiController {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly sessionService: SessionService,
    private readonly conversationsService: ConversationsService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  /**
   * GET /public/share/:shareToken
   * Returns a publicly shared conversation (title + user/assistant messages).
   * No authentication required.
   */
  @Get('share/:shareToken')
  async getSharedConversation(@Param('shareToken') shareToken: string) {
    if (!shareToken || shareToken.length < 10) throw new NotFoundException('Invalid share token');
    return this.conversationsService.getPublicShare(shareToken);
  }

  /**
   * POST /public/chat
   * Non-streaming chat for external bot integrations.
   *
   * Headers: X-API-Key: vrs_live_...
   * Body: { message, sessionId? }
   * Response: { reply, sessionId, tokensUsed }
   */
  @Post('chat')
  async chat(
    @Headers('x-api-key') rawKey: string,
    @Body() dto: PublicChatDto,
  ) {
    if (!rawKey) throw new UnauthorizedException('Missing X-API-Key header');
    const key = await this.apiKeysService.validateKey(rawKey);

    const sessionId = dto.sessionId ?? randomUUID();

    // Load or init session
    let session = await this.sessionService.getSession(sessionId);
    const isNewSession = !session;
    if (!session) {
      session = {
        conversationId: sessionId,
        tenantId: key.tenantId,
        assistantId: key.id,
        userId: key.id,
        recentMessages: [],
        lastActivity: Date.now(),
      };
      await this.sessionService.createSession(session);
      this.webhookDispatcher.emit(key.tenantId, 'conversation.created', {
        conversationId: sessionId,
        source: 'public-api',
        apiKeyId: key.id,
      });
    }

    // RAG
    let ragContext = '';
    if (key.authorizedAssistantIds?.length) {
      try {
        const results = await this.vectorSearchService.searchByAssistants(
          key.tenantId,
          key.authorizedAssistantIds,
          dto.message,
        );
        if (results.length > 0) {
          ragContext = results
            .map((r, i) => `[Source ${i + 1} | Relevance: ${(r.score * 100).toFixed(0)}%]:\n${r.content}`)
            .join('\n\n---\n\n');
        }
      } catch { /* continue without RAG */ }
    }

    const messages = this.buildMessages(key.systemPrompt, session.recentMessages, dto.message, ragContext);

    let llmResponse;
    try {
      llmResponse = await this.llmGatewayService.chat(messages, {
        provider: key.provider,
        model: key.model,
        temperature: 0.7,
        maxTokens: 2048,
      });
    } catch (err: any) {
      this.webhookDispatcher.emit(key.tenantId, 'assistant.error', {
        conversationId: sessionId,
        error: err?.message ?? 'LLM call failed',
        model: key.model,
        source: 'public-api',
      });
      throw err;
    }

    // Persist to session
    await this.sessionService.addMessage(sessionId, { role: MessageRole.USER, content: dto.message, timestamp: Date.now() });
    await this.sessionService.addMessage(sessionId, { role: MessageRole.ASSISTANT, content: llmResponse.content, timestamp: Date.now() });

    const tokensUsed = llmResponse.usage.promptTokens + llmResponse.usage.completionTokens;
    this.webhookDispatcher.emit(key.tenantId, 'message.created', {
      conversationId: sessionId,
      userMessage: dto.message,
      assistantMessage: llmResponse.content,
      model: key.model,
      tokensUsed,
      source: 'public-api',
    });

    return {
      reply: llmResponse.content,
      sessionId,
      tokensUsed,
    };
  }

  /**
   * POST /public/chat/stream
   * SSE streaming chat for external bots that support it.
   *
   * Headers: X-API-Key: vrs_live_...
   * Body: { message, sessionId? }
   * Streams: text/event-stream tokens, ends with [DONE]
   */
  @Post('chat/stream')
  async chatStream(
    @Headers('x-api-key') rawKey: string,
    @Body() dto: PublicChatDto,
    @Res() res: Response,
  ) {
    if (!rawKey) throw new UnauthorizedException('Missing X-API-Key header');
    const key = await this.apiKeysService.validateKey(rawKey);

    const sessionId = dto.sessionId ?? randomUUID();

    let session = await this.sessionService.getSession(sessionId);
    if (!session) {
      session = {
        conversationId: sessionId,
        tenantId: key.tenantId,
        assistantId: key.id,
        userId: key.id,
        recentMessages: [],
        lastActivity: Date.now(),
      };
      await this.sessionService.createSession(session);
      this.webhookDispatcher.emit(key.tenantId, 'conversation.created', {
        conversationId: sessionId,
        source: 'public-api-stream',
        apiKeyId: key.id,
      });
    }

    // RAG
    let ragContext = '';
    if (key.authorizedAssistantIds?.length) {
      try {
        const results = await this.vectorSearchService.searchByAssistants(
          key.tenantId,
          key.authorizedAssistantIds,
          dto.message,
        );
        if (results.length > 0) {
          ragContext = results
            .map((r, i) => `[Source ${i + 1} | Relevance: ${(r.score * 100).toFixed(0)}%]:\n${r.content}`)
            .join('\n\n---\n\n');
        }
      } catch { /* continue without RAG */ }
    }

    const messages = this.buildMessages(key.systemPrompt, session.recentMessages, dto.message, ragContext);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-Id', sessionId);
    res.flushHeaders();

    let fullContent = '';
    let streamError: string | null = null;
    try {
      for await (const token of this.llmGatewayService.chatStream(messages, {
        provider: key.provider,
        model: key.model,
        temperature: 0.7,
        maxTokens: 2048,
      })) {
        fullContent += token;
        res.write(`data: ${JSON.stringify(token)}\n\n`);
      }
      res.write(`data: "[DONE]"\n\n`);
    } catch (err: any) {
      streamError = err?.message ?? 'stream failed';
      res.write(`data: "[ERROR]"\n\n`);
    } finally {
      // Persist to session after stream
      try {
        await this.sessionService.addMessage(sessionId, { role: MessageRole.USER, content: dto.message, timestamp: Date.now() });
        if (fullContent) await this.sessionService.addMessage(sessionId, { role: MessageRole.ASSISTANT, content: fullContent, timestamp: Date.now() });
      } catch { /* best-effort */ }

      if (streamError) {
        this.webhookDispatcher.emit(key.tenantId, 'assistant.error', {
          conversationId: sessionId,
          error: streamError,
          model: key.model,
          source: 'public-api-stream',
        });
      } else if (fullContent) {
        this.webhookDispatcher.emit(key.tenantId, 'message.created', {
          conversationId: sessionId,
          userMessage: dto.message,
          assistantMessage: fullContent,
          model: key.model,
          tokensUsed: Math.ceil(fullContent.length / 4),
          source: 'public-api-stream',
        });
      }
      res.end();
    }
  }

  private buildMessages(
    systemPrompt: string | null,
    recentMessages: { role: MessageRole; content: string }[],
    userMessage: string,
    ragContext: string,
  ): LLMMessage[] {
    const msgs: LLMMessage[] = [];

    let sysContent = systemPrompt || 'You are a helpful assistant.';
    if (ragContext) {
      sysContent += `\n\n---\nIMPORTANT: You have been provided with relevant context from the knowledge base below. Base your answer primarily on this context.\n\nRelevant Knowledge Base Context:\n\n${ragContext}`;
    }
    msgs.push({ role: 'system', content: sysContent });

    for (const msg of recentMessages) {
      msgs.push({ role: msg.role === MessageRole.USER ? 'user' : 'assistant', content: msg.content });
    }

    msgs.push({ role: 'user', content: userMessage });
    return msgs;
  }
}
