/**
 * LLM Provider Interface
 * Common interface for all LLM providers.
 */
export interface LLMProvider {
  /** Provider identifier */
  readonly name: string;

  /**
   * Send chat completion request
   */
  chat(messages: LLMMessage[], options: LLMOptions): Promise<LLMResponse>;

  /**
   * Stream chat completion (optional — token by token via AsyncIterable)
   */
  chatStream?(messages: LLMMessage[], options: LLMOptions): AsyncIterable<string>;

  /**
   * Count tokens in text (approximate)
   */
  countTokens(text: string): number;

  /**
   * Check if provider is available
   */
  isAvailable(): boolean;
}

/**
 * Chat message format
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM request options
 */
export interface LLMOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
}

/**
 * LLM response format
 */
export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
}
