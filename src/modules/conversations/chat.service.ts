import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { SessionService } from './session.service';
import { AssistantsService } from '../assistants/assistants.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import { LlmGatewayService, LLMMessage } from '../llm-gateway/llm-gateway.service';
import { OcrService } from '../llm-gateway/ocr.service';
import { UsageService } from '../usage/usage.service';
import { QuotasService } from '../quotas/quotas.service';
import { ChatMessageDto, ChatResponse, MessageResponse } from './dto/conversation.dto';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { MessageRole, ContextChunk, MessageAttachment } from '../../database/entities/message.entity';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

/**
 * Prepared view of a user's turn once OCR has run.
 *   displayContent — what the user actually typed (what gets stored as the
 *                    visible user-bubble text; may be empty for image-only
 *                    turns — the UI will render the attachments instead)
 *   llmContent     — displayContent + OCR blocks; what the LLM actually sees
 *                    and what we push into the Redis session so follow-up
 *                    turns retain context
 *   attachments    — inline data-URLs persisted with the message so the chat
 *                    history re-renders thumbnails after a reload
 *   ocrFailed      — true when OCR ran but every provider failed; UI can
 *                    optionally show an "image read failed" hint
 */
interface PreparedUserTurn {
  displayContent: string;
  llmContent: string;
  attachments: MessageAttachment[] | null;
  ocrFailed: boolean;
}

/**
 * Rebuild the LLM-view of a user message from a persisted DB row. When the
 * Redis session TTL expires (1h) we reload context from `messages`, and a
 * user message with images needs its OCR text re-injected so follow-up
 * turns still have the image context.
 *
 * `content` holds only what the user typed; `attachments[i].ocrText` holds
 * whatever the OCR chain extracted at send time. This helper stitches them
 * back together in the same format `prepareUserTurn` produces live.
 */
function messageToLlmContent(row: {
  content: string;
  attachments?: MessageAttachment[] | null;
}): string {
  const typed = (row.content || '').trim();
  const atts = row.attachments ?? [];
  if (atts.length === 0) return typed;

  const sections = atts.map((a, i) => {
    const name = a.name || `image-${i + 1}`;
    const ocr = (a.ocrText || '').trim();
    if (!ocr) {
      // Matches the live prepareUserTurn fallback text exactly — otherwise
      // the model would treat a session-rebuilt turn as "no image present".
      return (
        `[Attached image: ${name}]\n` +
        `(Automatic text extraction produced no readable text. ` +
        `Answer the user's question based on what is visually present in the image. ` +
        `Do NOT tell the user that OCR failed.)`
      );
    }
    return `[Attached image: ${name}]\n--- Extracted text ---\n${ocr}\n--- End extracted text ---`;
  });
  const block = sections.join('\n\n');
  return typed ? `${typed}\n\n${block}` : block;
}

/**
 * Chat Service
 * Orchestrates the complete chat flow including RAG, LLM calls, and persistence.
 * 
 * Chat Flow:
 * 1. Resolve tenant context (handled by guard)
 * 2. Load conversation and session state
 * 3. Perform vector search if RAG enabled
 * 4. Build prompt with context
 * 5. Call LLM
 * 6. Persist messages
 * 7. Update session
 * 8. Log usage
 * 9. Return response
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly sessionService: SessionService,
    private readonly assistantsService: AssistantsService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly ocrService: OcrService,
    private readonly usageService: UsageService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly quotas: QuotasService,
  ) { }

  /**
   * Prepare a user's turn. When images are attached we:
   *   1. Persist each image as an inline data-URL attachment so the UI can
   *      re-render a thumbnail after reload.
   *   2. Run OCR on every image (multi-provider fallback chain handles the
   *      20 rpm Gemini free-tier cap).
   *   3. Produce TWO versions of the text: the clean `displayContent` the
   *      user typed (what shows in their chat bubble) and the enriched
   *      `llmContent` (what the model actually reasons over).
   *
   * This keeps the UI pristine while giving the assistant full context.
   */
  private async prepareUserTurn(dto: ChatMessageDto): Promise<PreparedUserTurn> {
    const rawText = (dto.message || '').trim();
    const images = dto.images ?? [];

    if (images.length === 0) {
      return {
        displayContent: rawText,
        llmContent: rawText,
        attachments: null,
        ocrFailed: false,
      };
    }

    if (!this.ocrService.isAvailable()) {
      this.logger.warn('Images attached but OCR is disabled (no vision keys)');
      const attachmentsNoOcr: MessageAttachment[] = images.map((img) => ({
        name: img.name,
        mimeType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.dataBase64}`,
      }));
      // Mirror the wording the fallback uses in the main branch so the model
      // never announces "OCR failed" or "unavailable" to the user.
      const imageBlocks = images
        .map(
          (img, i) =>
            `[Attached image: ${img.name || `image-${i + 1}`}]\n` +
            `(Automatic text extraction is unavailable. ` +
            `Answer based on what is visually present in the image. ` +
            `Do NOT tell the user that OCR is unavailable.)`,
        )
        .join('\n\n');
      return {
        displayContent: rawText,
        llmContent: rawText ? `${rawText}\n\n${imageBlocks}` : imageBlocks,
        attachments: attachmentsNoOcr,
        ocrFailed: true,
      };
    }

    const results = await this.ocrService.extractTextBatch(
      images.map((img) => ({
        mimeType: img.mimeType,
        dataBase64: img.dataBase64,
        filename: img.name,
      })),
    );
    const allFailed = results.every((r) => r.failed);

    // Pair the raw image bytes with the OCR text. `ocrText` is what we need
    // to rebuild the LLM view after the Redis session expires — see
    // `messageToLlmContent`.
    const attachments: MessageAttachment[] = images.map((img, i) => {
      const ocr = results[i];
      return {
        name: img.name,
        mimeType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.dataBase64}`,
        ocrText: ocr?.text || undefined,
      };
    });

    // Build the OCR block that gets injected into the LLM prompt. Two rules:
    //  1. NEVER leak internal provider names or HTTP errors into the prompt —
    //     the model tends to parrot them at the user ("OCR failed: 429 …").
    //  2. On total failure, give the model an *instruction* to fall back to
    //     visual reasoning rather than a verdict that shuts it down.
    const sections = results.map((r, i) => {
      const name = r.filename || `image-${i + 1}`;
      if (r.failed || !r.text) {
        // No usable text from OCR. Tell the model to answer using visual
        // reasoning without ever announcing an OCR failure to the user.
        return (
          `[Attached image: ${name}]\n` +
          `(Automatic text extraction produced no readable text. ` +
          `Answer the user's question based on what is visually present in the image — ` +
          `describe objects, scenes, colours, layout, handwriting style, or script if relevant. ` +
          `Do NOT tell the user that OCR failed.)`
        );
      }
      return `[Attached image: ${name}]\n--- Extracted text ---\n${r.text}\n--- End extracted text ---`;
    });

    const ocrBlock = sections.join('\n\n');
    const llmContent = rawText ? `${rawText}\n\n${ocrBlock}` : ocrBlock;

    return {
      displayContent: rawText,
      llmContent,
      attachments,
      ocrFailed: allFailed,
    };
  }

  /**
   * Process a chat message through the complete flow
   */
  async chat(tenant: TenantContext, conversationId: string, dto: ChatMessageDto): Promise<ChatResponse> {
    const startTime = Date.now();
    let assistant: any;

    // Fail fast if the org has already burned through its monthly token allowance.
    // Done before OCR/RAG/LLM work so we don't waste vendor calls on a request
    // that is going to be billed against a depleted quota.
    await this.quotas.assertMonthlyTokenQuota(tenant.tenantId);

    try {
      // Step 0: fire OCR concurrently with the DB reads below. OCR is the
      // slowest leg of the pipeline, so overlapping it with Postgres I/O
      // hides 100-300ms of latency on warm paths and a full second on cold
      // ones.
      const preparedPromise = this.prepareUserTurn(dto);

      // Step 1-2: Load conversation and assistant
      const conversation = await this.conversationsService.findOne(tenant, conversationId);
      assistant = await this.assistantsService.findOneEntity(tenant.tenantId, conversation.assistantId as string);

      // Step 3: Get session state (or create if expired).
      //
      // When rebuilding from DB we reconstruct each user message's
      // `llmContent` — i.e. typed text + [attached image] blocks with OCR
      // text — so follow-up turns after a session TTL expiry still retain
      // the full image context.
      let session = await this.sessionService.getSession(conversationId);
      if (!session) {
        const recentMessages = await this.conversationsService.getRecentMessages(conversationId);
        session = {
          conversationId,
          tenantId: tenant.tenantId,
          assistantId: assistant.id,
          userId: tenant.userId,
          recentMessages: recentMessages.reverse().map((m) => ({
            role: m.role,
            content:
              m.role === MessageRole.USER
                ? messageToLlmContent({ content: m.content, attachments: m.attachments })
                : m.content,
            timestamp: m.createdAt.getTime(),
          })),
          lastActivity: Date.now(),
        };
        await this.sessionService.createSession(session);
      }

      // We need the OCR output for both RAG and the LLM prompt.
      const prepared = await preparedPromise;
      const { displayContent, llmContent, attachments } = prepared;

      // Step 4: RAG - Vector search for relevant context
      let contextChunks: ContextChunk[] = [];
      let ragContext = '';

      if (assistant.ragEnabled) {
        try {
          // Look up linked datasets — if none linked, search all tenant documents
          const linkedDatasets = await this.assistantsService.getDatasets(tenant, assistant.id);
          const datasetIds = linkedDatasets.length > 0 ? linkedDatasets.map((d) => d.id) : undefined;

          const searchResults = await this.vectorSearchService.search(
            tenant.tenantId,
            datasetIds,
            llmContent,
            assistant.ragTopK,
          );

          contextChunks = searchResults.map((r) => ({
            documentId: r.documentId,
            chunkId: r.chunkId,
            content: r.content,
            score: r.score,
          }));

          if (contextChunks.length > 0) {
            ragContext = this.buildRagContext(contextChunks);
          }
        } catch (error) {
          this.logger.warn(`RAG search failed for conversation ${conversationId}`, error);
          // Continue without RAG context
        }
      }

      // Step 5: Build prompt messages
      const messages = this.buildPromptMessages(
        assistant.systemPrompt,
        session.recentMessages,
        llmContent,
        ragContext,
        session.summary,
      );

      // Step 6: Call LLM (DTO overrides take precedence for playground use)
      const llmResponse = await this.llmGatewayService.chat(messages, {
        provider: assistant.provider,
        model: assistant.model,
        temperature: dto.temperature ?? Number(assistant.temperature),
        maxTokens: dto.maxTokens ?? assistant.maxTokens,
        topP: dto.topP,
      });

      // Step 7: Save user message + assistant response + update token count atomically
      const totalTokens = llmResponse.usage.promptTokens + llmResponse.usage.completionTokens;
      const { assistantMessage } = await this.conversationsService.saveMessagePair(
        tenant.tenantId,
        conversationId,
        displayContent,
        llmResponse.usage.promptTokens,
        llmResponse.content,
        llmResponse.usage.completionTokens,
        llmResponse.model,
        contextChunks.length > 0 ? contextChunks : undefined,
        attachments,
      );

      this.webhookDispatcher.emit(tenant.tenantId, 'message.created', {
        conversationId,
        messageId: assistantMessage.id,
        userMessage: displayContent,
        assistantMessage: llmResponse.content,
        model: llmResponse.model,
        tokensUsed: totalTokens,
      });

      // Step 8: Update session (best-effort — non-critical)
      //
      // Session recent-messages use `llmContent` (OCR-enriched) so the next
      // turn still has the image context — even though the DB shows only the
      // user's typed text.
      try {
        await this.sessionService.addMessage(conversationId, {
          role: MessageRole.USER,
          content: llmContent,
          timestamp: Date.now(),
        });
        await this.sessionService.addMessage(conversationId, {
          role: MessageRole.ASSISTANT,
          content: llmResponse.content,
          timestamp: Date.now(),
        });
      } catch (sessionError) {
        this.logger.warn(`Failed to update session for conversation ${conversationId}`, sessionError);
      }

      // Auto-generate title for new conversations (best-effort)
      if (!conversation.title || conversation.title === 'New Conversation') {
        this.generateTitle(tenant, conversationId, dto.message, assistant).catch((err) => {
          this.logger.error(`Failed to generate auto-title for conversation ${conversationId}`, err);
        });
      }

      // Step 9: Log usage (best-effort)
      const latencyMs = Date.now() - startTime;
      this.usageService.logUsage({
        tenantId: tenant.tenantId,
        assistantId: assistant.id,
        userId: tenant.userId,
        conversationId,
        tokensInput: llmResponse.usage.promptTokens,
        tokensOutput: llmResponse.usage.completionTokens,
        model: llmResponse.model,
        provider: assistant.provider,
        latencyMs,
        success: true,
      }).catch((err) => {
        this.logger.warn(`Failed to log usage for conversation ${conversationId}`, err);
      });

      // Build response
      const messageResponse: MessageResponse = {
        id: assistantMessage.id,
        role: 'assistant',
        content: llmResponse.content,
        tokensUsed: llmResponse.usage.completionTokens,
        model: llmResponse.model,
        vote: null,
        createdAt: assistantMessage.createdAt,
      };

      return {
        message: messageResponse,
        conversationId,
        tokensUsed: {
          input: llmResponse.usage.promptTokens,
          output: llmResponse.usage.completionTokens,
          total: totalTokens,
        },
        contextChunks: contextChunks.length > 0 ? contextChunks.map((c) => ({
          documentId: c.documentId,
          content: c.content,
          score: c.score,
        })) : undefined,
      };
    } catch (error) {
      // Log failed usage (best-effort)
      this.usageService.logUsage({
        tenantId: tenant.tenantId,
        assistantId: assistant?.id ?? null,
        userId: tenant.userId,
        conversationId,
        tokensInput: 0,
        tokensOutput: 0,
        model: assistant?.model ?? 'unknown',
        provider: assistant?.provider ?? 'unknown',
        latencyMs: Date.now() - startTime,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      }).catch(() => {});

      this.webhookDispatcher.emit(tenant.tenantId, 'assistant.error', {
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error',
        model: assistant?.model,
      });

      // Re-throw the original error for the controller/filter to handle
      throw error;
    }
  }

  /**
   * Process a chat message and stream the response token by token.
   * Yields string tokens as they arrive from the LLM.
   * After the stream ends, saves both messages to the DB.
   */
  async *chatStream(
    tenant: TenantContext,
    conversationId: string,
    dto: ChatMessageDto,
  ): AsyncIterable<string> {
    const startTime = Date.now();

    // Fail fast on monthly token overage before any vendor calls run.
    await this.quotas.assertMonthlyTokenQuota(tenant.tenantId);

    // Kick off OCR concurrently with the DB reads (conversation + assistant +
    // session). Previously every ms of OCR added to the TTFB; now OCR runs in
    // parallel with Postgres I/O so the user sees the LLM start streaming
    // roughly at max(OCR, DB) instead of OCR + DB.
    const preparedPromise = this.prepareUserTurn(dto);
    const conversation = await this.conversationsService.findOne(tenant, conversationId);
    const assistant = await this.assistantsService.findOneEntity(tenant.tenantId, conversation.assistantId as string);

    let session = await this.sessionService.getSession(conversationId);
    if (!session) {
      const recentMessages = await this.conversationsService.getRecentMessages(conversationId);
      session = {
        conversationId,
        tenantId: tenant.tenantId,
        assistantId: assistant.id,
        userId: tenant.userId,
        recentMessages: recentMessages.reverse().map((m) => ({
          role: m.role,
          content:
            m.role === MessageRole.USER
              ? messageToLlmContent({ content: m.content, attachments: m.attachments })
              : m.content,
          timestamp: m.createdAt.getTime(),
        })),
        lastActivity: Date.now(),
      };
      await this.sessionService.createSession(session);
    }

    // Now we're about to need the OCR text.
    const prepared = await preparedPromise;
    const { displayContent, llmContent, attachments } = prepared;

    // RAG
    let contextChunks: ContextChunk[] = [];
    let ragContext = '';
    if (assistant.ragEnabled) {
      try {
        // Look up linked datasets — if none linked, search all tenant documents
        const linkedDatasets = await this.assistantsService.getDatasets(tenant, assistant.id);
        const datasetIds = linkedDatasets.length > 0 ? linkedDatasets.map((d) => d.id) : undefined;

        const searchResults = await this.vectorSearchService.search(
          tenant.tenantId,
          datasetIds,
          llmContent,
          assistant.ragTopK,
        );
        contextChunks = searchResults.map((r) => ({
          documentId: r.documentId,
          chunkId: r.chunkId,
          content: r.content,
          score: r.score,
        }));
        if (contextChunks.length > 0) ragContext = this.buildRagContext(contextChunks);
      } catch (error) {
        this.logger.warn(`RAG search failed for streaming conversation ${conversationId}`, error);
      }
    }

    const messages = this.buildPromptMessages(
      assistant.systemPrompt,
      session.recentMessages,
      llmContent,
      ragContext,
      session.summary,
    );

    // Resolve effective provider/model — fallback overrides take precedence over assistant config
    const effectiveProvider = dto.fallbackProvider || assistant.provider;
    const effectiveModel = dto.fallbackModel || assistant.model;

    // Save user message immediately (skip on retry — already saved by the first failed attempt).
    // `displayContent` = what the user typed; `attachments` = the uploaded
    // images as data-URLs. OCR-enriched text is NOT saved to DB — it goes to
    // the Redis session only so future turns retain context.
    if (!dto.isRetry) {
      await this.conversationsService.saveMessage(
        tenant.tenantId,
        conversationId,
        MessageRole.USER,
        displayContent,
        0,
        undefined,
        undefined,
        attachments,
      );
    }

    // Stream tokens from LLM (DTO overrides take precedence for playground use)
    let fullContent = '';
    try {
      for await (const token of this.llmGatewayService.chatStream(messages, {
        provider: effectiveProvider,
        model: effectiveModel,
        temperature: dto.temperature ?? Number(assistant.temperature),
        maxTokens: dto.maxTokens ?? assistant.maxTokens,
        topP: dto.topP,
      })) {
        fullContent += token;
        yield token;
      }
    } catch (error) {
      this.logger.error(`LLM stream failed for conversation ${conversationId}`, error);
      // Log failed usage
      this.usageService.logUsage({
        tenantId: tenant.tenantId,
        assistantId: assistant.id ?? null,
        userId: tenant.userId,
        conversationId,
        tokensInput: 0,
        tokensOutput: 0,
        model: effectiveModel ?? 'unknown',
        provider: effectiveProvider ?? 'unknown',
        latencyMs: Date.now() - startTime,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Stream failed',
      }).catch(() => {});
      this.webhookDispatcher.emit(tenant.tenantId, 'assistant.error', {
        conversationId,
        error: error instanceof Error ? error.message : 'Stream failed',
        model: effectiveModel,
      });
      throw error;
    }

    // Post-stream persistence (best-effort for non-critical steps)
    let savedAssistantMessageId: string | undefined;
    try {
      // Save assistant response after stream completes
      const saved = await this.conversationsService.saveMessage(
        tenant.tenantId,
        conversationId,
        MessageRole.ASSISTANT,
        fullContent,
        Math.ceil(fullContent.length / 4),
        effectiveModel,
        contextChunks.length > 0 ? contextChunks : undefined,
      );
      savedAssistantMessageId = saved.id;
    } catch (error) {
      this.logger.error(`Failed to save streamed assistant message for conversation ${conversationId}`, error);
    }

    this.webhookDispatcher.emit(tenant.tenantId, 'message.created', {
      conversationId,
      messageId: savedAssistantMessageId,
      userMessage: displayContent,
      assistantMessage: fullContent,
      model: effectiveModel,
      tokensUsed: Math.ceil(fullContent.length / 4),
    });

    // Update session (best-effort). The session captures `llmContent` so the
    // next turn still has OCR-enriched context even though the DB row only
    // shows the user's typed text.
    try {
      await this.sessionService.addMessage(conversationId, { role: MessageRole.USER, content: llmContent, timestamp: Date.now() });
      await this.sessionService.addMessage(conversationId, { role: MessageRole.ASSISTANT, content: fullContent, timestamp: Date.now() });
    } catch (error) {
      this.logger.warn(`Failed to update session after stream for conversation ${conversationId}`, error);
    }

    // Auto-title (best-effort, fire-and-forget)
    if (!conversation.title || conversation.title === 'New Conversation') {
      this.generateTitle(tenant, conversationId, dto.message, assistant).catch((err) => {
        this.logger.error('Auto-title failed', err);
      });
    }

    // Usage log (best-effort)
    this.usageService.logUsage({
      tenantId: tenant.tenantId,
      assistantId: assistant.id,
      userId: tenant.userId,
      conversationId,
      tokensInput: 0,
      tokensOutput: Math.ceil(fullContent.length / 4),
      model: effectiveModel,
      provider: effectiveProvider,
      latencyMs: Date.now() - startTime,
      success: true,
    }).catch(() => { });
  }

  /**
   * Generate auto-title for a conversation (best-effort, fire-and-forget)
   */
  private async generateTitle(
    tenant: TenantContext,
    conversationId: string,
    userMessage: string,
    assistant: any,
  ): Promise<void> {
    const titlePrompt: LLMMessage[] = [
      { role: 'system', content: 'Generate a very brief, concise title (max 4 words) for a new chat about this topic. Return ONLY the title text, no quotes, no markdown, no extra words.' },
      { role: 'user', content: userMessage },
    ];

    const titleResponse = await this.llmGatewayService.chat(titlePrompt, {
      provider: assistant.provider,
      model: assistant.model,
      temperature: 0.3,
      maxTokens: 15,
    });

    const generatedTitle = titleResponse.content.replace(/["']/g, '').trim();
    if (generatedTitle) {
      await this.conversationsService.update(tenant, conversationId, generatedTitle);
    }
  }

  private buildRagContext(chunks: ContextChunk[]): string {
    const contextParts = chunks.map((chunk, index) =>
      `[Source ${index + 1} | Relevance: ${(chunk.score * 100).toFixed(0)}%]:\n${chunk.content}`
    );
    return contextParts.join('\n\n---\n\n');
  }

  /**
   * Build prompt messages array for LLM
   */
  private buildPromptMessages(
    systemPrompt: string,
    recentMessages: { role: MessageRole; content: string }[],
    userMessage: string,
    ragContext: string,
    summary?: string,
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // System message with optional RAG context
    let systemContent = systemPrompt;
    if (ragContext) {
      systemContent += `\n\n---\nIMPORTANT: You have been provided with relevant context from the knowledge base below. You MUST use this context to answer the user's question. Follow these rules strictly:\n1. Base your answer PRIMARILY on the provided context.\n2. If the context contains the answer, use it directly and cite which context section you used.\n3. If the context does NOT contain enough information to answer the question, clearly state: "Based on the available documents, I don't have specific information about that."\n4. Do NOT make up or hallucinate information that is not in the context.\n5. You may use your general knowledge only to supplement or explain concepts from the context, but never to contradict it.\n\nRelevant Knowledge Base Context:\n\n${ragContext}`;
    }
    messages.push({ role: 'system', content: systemContent });

    // Add conversation summary if available
    if (summary) {
      messages.push({ role: 'system', content: `Previous conversation summary: ${summary}` });
    }

    // Add recent messages for context
    for (const msg of recentMessages) {
      messages.push({
        role: msg.role === MessageRole.USER ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    return messages;
  }
}
