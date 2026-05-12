import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';

/**
 * Cached blob wrapper — the payload we store in Redis.
 * Stored as a single Buffer: 4-byte JSON-header length prefix + JSON header + raw bytes.
 * This avoids a second Redis round-trip for the mime type / etag.
 */
interface CachedBlobMeta {
  mime: string;
  etag: string;
}

/** Only cache objects up to this size. Larger objects stream straight from S3. */
const CACHE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
/** Default cache TTL for immutable-ish media (logos, profile photos, documents). */
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 h

/**
 * Storage Service
 * Handles S3-compatible object storage operations (MinIO in dev, AWS S3 in prod).
 *
 * Performance note: logo / profile-photo / small-document downloads are fronted by a
 * Redis byte-cache to keep the Node.js event loop out of S3 traffic under high concurrency.
 * See `downloadFileCached()`.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly cache: Redis | null;

  constructor(private readonly configService: ConfigService) {
    this.s3Client = new S3Client({
      endpoint: this.configService.get<string>('s3.endpoint'),
      region: this.configService.get<string>('s3.region'),
      credentials: {
        accessKeyId: this.configService.get<string>('s3.accessKey') || '',
        secretAccessKey: this.configService.get<string>('s3.secretKey') || '',
      },
      forcePathStyle: true, // Required for MinIO
    });
    this.bucket = this.configService.get<string>('s3.bucket') || 'aisle-documents';
    this.cache = this.initCache();
  }

  private initCache(): Redis | null {
    const host = this.configService.get<string>('redis.host');
    const port = this.configService.get<number>('redis.port');
    if (!host) {
      this.logger.warn('Redis not configured; StorageService cache disabled');
      return null;
    }
    const tlsEnv = (process.env.REDIS_TLS ?? '').toLowerCase();
    const useTls = tlsEnv
      ? tlsEnv === 'true' || tlsEnv === '1'
      : !!host?.includes('cache.amazonaws.com');
    const client = new Redis({
      host,
      port,
      ...(useTls ? { tls: {} } : {}),
      enableOfflineQueue: false,
    });
    client.on('error', (err) => {
      this.logger.warn(`StorageService Redis cache error: ${err.message}`);
    });
    return client;
  }

  async onModuleDestroy() {
    try {
      await this.cache?.quit();
    } catch {
      /* ignore */
    }
  }

  private cacheKey(s3Key: string): string {
    // Namespaced so this cache can't collide with session keys or other consumers.
    return `filecache:v1:${s3Key}`;
  }

  private computeEtag(buf: Buffer): string {
    return `W/"${createHash('sha1').update(buf).digest('hex').substring(0, 16)}"`;
  }

  private encode(buf: Buffer, meta: CachedBlobMeta): Buffer {
    const header = Buffer.from(JSON.stringify(meta), 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.length, 0);
    return Buffer.concat([prefix, header, buf]);
  }

  private decode(blob: Buffer): { buf: Buffer; meta: CachedBlobMeta } {
    const headerLen = blob.readUInt32BE(0);
    const meta = JSON.parse(blob.subarray(4, 4 + headerLen).toString('utf8')) as CachedBlobMeta;
    const buf = blob.subarray(4 + headerLen);
    return { buf, meta };
  }

  /**
   * Generate S3 key for a document
   */
  generateKey(tenantId: string, filename: string): string {
    const timestamp = Date.now();
    const uuid = uuidv4().substring(0, 8);
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    return `${tenantId}/${timestamp}-${uuid}-${sanitizedFilename}`;
  }

  /**
   * Upload file to S3
   */
  async uploadFile(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
      this.logger.log(`Uploaded file: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to upload file: ${key}`, error);
      throw error;
    }
    await this.invalidateCache(key);
  }

  /**
   * Download file from S3
   */
  async downloadFile(key: string): Promise<Buffer> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    } catch (error) {
      this.logger.error(`Failed to download file: ${key}`, error);
      throw error;
    }
  }

  /**
   * Download file from S3 with a Redis byte-cache.
   *
   * Returns { buf, mime, etag, hit }. Objects larger than `CACHE_MAX_BYTES` are
   * never cached (they'd blow up Redis memory); for those this method is equivalent
   * to `downloadFile()` and returns `hit: false`.
   *
   * The caller is responsible for writing the bytes to the HTTP response; this lets
   * us avoid opening a fresh S3 stream for every concurrent request to the same file.
   */
  async downloadFileCached(
    key: string,
    mimeHint?: string,
  ): Promise<{ buf: Buffer; mime: string; etag: string; hit: boolean }> {
    // 1. Try cache
    if (this.cache) {
      try {
        const blob = await this.cache.getBuffer(this.cacheKey(key));
        if (blob && blob.length > 4) {
          const { buf, meta } = this.decode(blob);
          return { buf, mime: meta.mime, etag: meta.etag, hit: true };
        }
      } catch (err) {
        this.logger.warn(`Cache read failed for ${key}: ${(err as Error).message}`);
      }
    }

    // 2. Fetch from S3
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    const buf = await new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const mime = mimeHint || response.ContentType || 'application/octet-stream';
    // Prefer S3's ETag if present (unquoted); fall back to sha1 of bytes.
    const etag =
      typeof response.ETag === 'string' && response.ETag.length > 0
        ? response.ETag.replace(/^W\//, '')
        : this.computeEtag(buf);

    // 3. Populate cache (best-effort, fire-and-forget)
    if (this.cache && buf.length <= CACHE_MAX_BYTES) {
      const payload = this.encode(buf, { mime, etag });
      this.cache
        .set(this.cacheKey(key), payload, 'EX', CACHE_TTL_SECONDS)
        .catch((err) => this.logger.warn(`Cache write failed for ${key}: ${err.message}`));
    }

    return { buf, mime, etag, hit: false };
  }

  /**
   * Drop a cached file. Safe to call when not cached or when Redis is down.
   */
  async invalidateCache(key: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.del(this.cacheKey(key));
    } catch (err) {
      this.logger.warn(`Cache invalidation failed for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Get a readable stream for a file from S3
   */
  async getFileStream(key: string): Promise<Readable> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      return response.Body as Readable;
    } catch (error) {
      this.logger.error(`Failed to get file stream: ${key}`, error);
      throw error;
    }
  }

  /**
   * Delete file from S3
   */
  async deleteFile(key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      this.logger.log(`Deleted file: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete file: ${key}`, error);
      throw error;
    }
    await this.invalidateCache(key);
  }

  /**
   * Check if file exists
   */
  async fileExists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (error) {
      return false;
    }
  }
}
