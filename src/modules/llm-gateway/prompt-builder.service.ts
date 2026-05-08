import { Injectable, Logger } from '@nestjs/common';
import { LLMMessage } from './interfaces/llm-provider.interface';

/**
 * Prompt Builder Service
 * Assembles prompts with system instructions, context, and conversation history.
 */
@Injectable()
export class PromptBuilderService {
  private readonly logger = new Logger(PromptBuilderService.name);

  /**
   * Build a prompt with RAG context
   */
  buildPromptWithContext(
    systemPrompt: string,
    contextChunks: string[],
    conversationHistory: LLMMessage[],
    userMessage: string,
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // Build enhanced system prompt with context
    let enhancedSystemPrompt = systemPrompt;

    if (contextChunks.length > 0) {
      enhancedSystemPrompt += `\n\n---\n\nUse the following relevant information to help answer the user's question:\n\n`;
      contextChunks.forEach((chunk, index) => {
        enhancedSystemPrompt += `[Source ${index + 1}]:\n${chunk}\n\n`;
      });
      enhancedSystemPrompt += `---\n\nProvide accurate answers based on the context above. If the context doesn't contain relevant information, say so and provide the best answer you can.`;
    }

    messages.push({ role: 'system', content: enhancedSystemPrompt });

    // Add conversation history
    for (const msg of conversationHistory) {
      if (msg.role !== 'system') {
        messages.push(msg);
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  /**
   * Estimate total tokens in a prompt
   */
  estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // Rough approximation: 4 chars per token + overhead for role
      total += Math.ceil(msg.content.length / 4) + 4;
    }
    return total;
  }

  /**
   * Truncate messages to fit token limit
   */
  truncateToFit(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
    const result: LLMMessage[] = [];
    let tokenCount = 0;

    // Always include system message
    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      result.push(systemMsg);
      tokenCount += this.estimateTokens([systemMsg]);
    }

    // Always include the last user message
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    if (lastUserMsg) {
      tokenCount += this.estimateTokens([lastUserMsg]);
    }

    // Add as many conversation messages as we can fit
    const conversationMsgs = messages.filter(
      (m) => m.role !== 'system' && m !== lastUserMsg,
    );

    const fittingMsgs: LLMMessage[] = [];
    for (const msg of conversationMsgs.reverse()) {
      const msgTokens = this.estimateTokens([msg]);
      if (tokenCount + msgTokens <= maxTokens) {
        fittingMsgs.unshift(msg);
        tokenCount += msgTokens;
      } else {
        break;
      }
    }

    result.push(...fittingMsgs);
    if (lastUserMsg) {
      result.push(lastUserMsg);
    }

    return result;
  }
}
