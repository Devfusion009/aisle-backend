import { Injectable, Logger } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');
import mammoth from 'mammoth';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

/**
 * Extraction Service
 * Extracts text content from various document formats.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  /**
   * Extract text from a document based on MIME type
   */
  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    let text = '';
    switch (mimeType) {
      case 'application/pdf':
        text = await this.extractFromPdf(buffer);
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        text = await this.extractFromDocx(buffer);
        break;
      case 'text/plain':
        text = this.extractFromText(buffer);
        break;
      default:
        throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
    
    // PostgreSQL does not support null characters (0x00) in text fields.
    return text.replace(/\0/g, '');
  }

  /**
   * Extract text from PDF using pdf-parse v1, safely failing over to OS-native OCR scanning.
   */
  private async extractFromPdf(buffer: Buffer): Promise<string> {
    try {
      const data = await pdfParse(buffer);
      let text = data.text;
      
      // If the PDF is completely structureless (scanned document), pdfParse yields nothing cleanly.
      // Eject cleanly into OCR scanning instead of yielding an error immediately!
      if (!text || text.trim().length === 0) {
        this.logger.warn('pdf-parse returned no text, attempting Advanced OCR fallback...');
        text = await this.performOcrFallback(buffer);
      }
      
      return text;
    } catch (error) {
      if (error instanceof Error && (error.message.includes('No text content') || error.message.includes('Invalid PDF structure'))) {
        this.logger.warn('pdf-parse threw an extraction error, attempting OCR fallback...', error);
        return await this.performOcrFallback(buffer);
      }
      this.logger.error('Failed to extract text from PDF', error);
      throw new Error(
        `Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Performs advanced Image Rasterization and OCR text extraction using OS utility binaries.
   * Requires `poppler-utils` and `tesseract-ocr` installed on the host.
   */
  private async performOcrFallback(buffer: Buffer): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-ocr-'));
    const pdfPath = path.join(tmpDir, 'document.pdf');
    const imagePrefix = path.join(tmpDir, 'page');
    
    try {
      // 1. Snapshot the PDF safely to disk
      await fs.writeFile(pdfPath, buffer);
      
      // 2. Fragment standard PDF into isolated raw JPEGs.
      this.logger.log('Starting pdftoppm document rasterization...');
      await execAsync(`pdftoppm -jpeg -r 150 "${pdfPath}" "${imagePrefix}"`);
      
      // 3. Assemble rendering targets
      const files = await fs.readdir(tmpDir);
      const images = files.filter(f => f.startsWith('page-') && f.endsWith('.jpg')).sort();
      
      if (images.length === 0) {
        throw new Error('pdftoppm produced zero discernible structural images');
      }
      
      this.logger.log(`Executing raw Tesseract OCR Engine on ${images.length} pages...`);
      let fullText = '';
      
      // We run Tesseract in a strict sequence to preserve actual reading order
      for (const img of images) {
        const imgPath = path.join(tmpDir, img);
        const { stdout } = await execAsync(`tesseract "${imgPath}" stdout -l eng`);
        fullText += stdout + '\n\n';
      }
      
      if (!fullText || fullText.trim().length === 0) {
         throw new Error('Tesseract processed the blocks but found no recognized letters');
      }
      
      this.logger.log('OCR successfully recovered structural textual layout!');
      return fullText;
    } catch (e) {
      this.logger.error('Full OCR fallback gracefully aborted (ensure poppler-utils and tesseract-ocr exist via apt-get)', e);
      return '';
    } finally {
      // Burn evidence unconditionally regardless of OS outcome
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Extract text from DOCX
   */
  private async extractFromDocx(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error) {
      this.logger.error('Failed to extract text from DOCX', error);
      throw new Error('Failed to extract text from DOCX');
    }
  }

  /**
   * Extract text from plain text file
   */
  private extractFromText(buffer: Buffer): string {
    return buffer.toString('utf-8');
  }
}
