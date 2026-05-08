import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Res,
  Logger
} from '@nestjs/common';
import { Response } from 'express';
import { ConversationsService } from './conversations.service';
import { ChatService } from './chat.service';
import {
  CreateConversationDto,
  ChatMessageDto,
  ConversationResponse,
  MessageResponse,
  ChatResponse,
  UpdateConversationDto,
  VoteMessageDto,
} from './dto/conversation.dto';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Conversations Controller
 * REST API endpoints for conversation and chat management.
 */
@Controller('conversations')
export class ConversationsController {
  private readonly logger = new Logger(ConversationsController.name);

  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly chatService: ChatService,
  ) { }

  /**
   * Create a new conversation
   * POST /conversations
   */
  @Post()
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateConversationDto,
  ): Promise<ConversationResponse> {
    return this.conversationsService.create(tenant, dto);
  }

  /**
   * List all conversations for the current user
   * GET /conversations
   */
  @Get()
  async findAll(@Tenant() tenant: TenantContext): Promise<ConversationResponse[]> {
    return this.conversationsService.findAll(tenant);
  }

  /**
   * Update a conversation
   * POST /conversations/:id/update
   */
  @Post(':id/update')
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationDto,
  ): Promise<ConversationResponse> {
    return this.conversationsService.update(tenant, id, dto.title);
  }

  /**
   * Delete a conversation
   * POST /conversations/:id/delete
   */
  @Post(':id/delete')
  async delete(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ success: boolean }> {
    await this.conversationsService.delete(tenant, id);
    return { success: true };
  }

  /**
   * Toggle pin status
   * POST /conversations/:id/pin
   */
  @Post(':id/pin')
  async togglePin(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationResponse> {
    return this.conversationsService.togglePin(tenant, id);
  }

  /**
   * Toggle archive status
   * POST /conversations/:id/archive
   */
  @Post(':id/archive')
  async toggleArchive(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationResponse> {
    return this.conversationsService.toggleArchive(tenant, id);
  }

  /**
   * Get messages for a conversation
   * GET /conversations/:id/messages
   */
  @Get(':id/messages')
  async getMessages(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageResponse[]> {
    return this.conversationsService.getMessages(tenant, id);
  }

  /**
   * Enable public sharing for a conversation — returns a stable shareToken.
   * POST /conversations/:id/share
   */
  @Post(':id/share')
  async enableShare(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ shareToken: string }> {
    return this.conversationsService.enableShare(tenant, id);
  }

  /**
   * Vote on a message (thumbs up/down)
   * POST /conversations/messages/:messageId/vote
   */
  @Post('messages/:messageId/vote')
  async voteMessage(
    @Tenant() tenant: TenantContext,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: VoteMessageDto,
  ): Promise<{ messageId: string; vote: 'up' | 'down' | null }> {
    return this.conversationsService.voteMessage(tenant, messageId, dto.vote);
  }

  /**
   * Send a chat message (non-streaming)
   * POST /conversations/:id/chat
   */
  @Post(':id/chat')
  async chat(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChatMessageDto,
  ): Promise<ChatResponse> {
    return this.chatService.chat(tenant, id, dto);
  }

  /**
   * Send a chat message — streaming SSE response
   * POST /conversations/:id/chat/stream
   *
   * Emits text/event-stream. Each token is sent as:
   *   data: "token"\n\n
   * Finished with:
   *   data: "[DONE]"\n\n
   */
  @Post(':id/chat/stream')
  async chatStream(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChatMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    try {
      for await (const token of this.chatService.chatStream(tenant, id, dto)) {
        res.write(`data: ${JSON.stringify(token)}\n\n`);
      }
      res.write('data: "[DONE]"\n\n');
    } catch (err: any) {
      this.logger.error(`Chat stream error: ${err.message}`, err.stack);

      let errorMsg = 'The assistant failed to respond. Please try again later.';
      let code = 'llm_error';
      let fallbackEligible = false;

      // Quota / plan-limit rejection — surface the user-friendly message verbatim,
      // do not offer a fallback model (the org is over its allowance, not the model).
      if (err?.status === 403 && typeof err?.message === 'string') {
        errorMsg = err.message;
        code = 'quota_exceeded';
      } else if (err?.status === 401 || err?.code === 'invalid_api_key' || err?.message?.includes('401')) {
        errorMsg = 'API Key Error: The configured API key is missing or invalid. Please check the Assistant settings.';
        code = 'auth_error';
      } else if (err?.status === 429 || err?.constructor?.name === 'RateLimitError' || err?.message?.includes('429')) {
        errorMsg = 'Rate Limit Hit: This assistant has exhausted its API quota or rate limit. Switch to a fallback model to continue.';
        code = 'rate_limit';
        fallbackEligible = true;
      } else if (err?.status === 404 || err?.message?.includes('404')) {
        errorMsg = `Model/Endpoint Not Found (404): The configured model is unavailable. Switch to a fallback model to continue.`;
        code = 'not_found';
        fallbackEligible = true;
      } else if (err?.status || err?.code) {
        errorMsg = `API Error [${err?.status || err?.code}]: ${err.message}`;
      } else {
        errorMsg = err.message || errorMsg;
      }

      const errorEvent: Record<string, unknown> = { type: 'error', code, message: errorMsg };

      if (fallbackEligible) {
        errorEvent.fallback_available = true;
        errorEvent.fallback_options = [
          {
            provider: 'mistral',
            model: 'mistral-small-latest',
            label: 'Mistral Small',
            description: 'Direct Mistral AI API',
          },
          {
            provider: 'openrouter',
            model: 'openai/gpt-4o-mini',
            label: 'GPT-4o Mini',
            description: 'OpenAI model via OpenRouter',
          },
        ];
      }

      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    } finally {
      res.end();
    }
  }
}
