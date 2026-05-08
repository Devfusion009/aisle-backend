import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Text chunk with metadata
 */
export interface TextChunk {
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

/**
 * Chunking Service
 * Splits text into overlapping chunks for embedding.
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(private readonly configService: ConfigService) {
    this.chunkSize = this.configService.get<number>('rag.chunkSize') || 512;
    this.chunkOverlap = this.configService.get<number>('rag.chunkOverlap') || 50;
  }

  /**
   * Split text into chunks
   * Uses sentence-aware splitting with character-based fallback
   */
  chunkText(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    
    // Clean and normalize text
    const cleanedText = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleanedText) {
      return [];
    }

    const maxChars = this.chunkSize * 4;
    const overlapChars = this.chunkOverlap * 4;

    // Sentence-aware split first, then hard-split any sentence that blew past maxChars
    // (long tables, code blocks, scanned PDFs can produce multi-KB "sentences" that
    // otherwise become monster chunks and wreck retrieval precision + embedding limits).
    const sentences = this.splitIntoSentences(cleanedText).flatMap((s) =>
      s.length > maxChars ? this.hardSplit(s, maxChars) : [s],
    );

    let currentChunk = '';
    let currentStartOffset = 0;
    let chunkIndex = 0;

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxChars && currentChunk) {
        chunks.push(this.createChunk(currentChunk, chunkIndex, currentStartOffset));

        const overlapStart = Math.max(0, currentChunk.length - overlapChars);
        const overlap = currentChunk.substring(overlapStart);
        currentStartOffset = currentStartOffset + currentChunk.length - overlap.length;
        currentChunk = overlap + sentence;
        chunkIndex++;
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(this.createChunk(currentChunk, chunkIndex, currentStartOffset));
    }

    this.logger.log(`Split text into ${chunks.length} chunks`);
    return chunks;
  }

  /**
   * Hard-split an oversized segment at word boundaries when possible, falling back to
   * a raw character slice. Guarantees every returned piece is ≤ maxChars.
   */
  private hardSplit(text: string, maxChars: number): string[] {
    const pieces: string[] = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf(' ', maxChars);
      if (cut <= maxChars * 0.5) cut = maxChars; // no reasonable whitespace → raw slice
      pieces.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining.length > 0) pieces.push(remaining);
    return pieces;
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitting on common delimiters
    const sentences: string[] = [];
    const parts = text.split(/(?<=[.!?]\s)|(?<=\n\n)/);
    
    for (const part of parts) {
      if (part.trim()) {
        sentences.push(part);
      }
    }
    
    return sentences;
  }

  /**
   * Create a chunk object
   */
  private createChunk(content: string, index: number, startOffset: number): TextChunk {
    return {
      content: content.trim(),
      index,
      startOffset,
      endOffset: startOffset + content.length,
      tokenCount: this.estimateTokens(content),
    };
  }

  /**
   * Estimate token count (rough approximation: 1 token ≈ 4 chars)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
