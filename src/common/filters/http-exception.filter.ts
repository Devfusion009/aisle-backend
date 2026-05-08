import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';

/**
 * Standardised error response shape — every error the API returns follows this.
 *
 *   .NET analogy: ProblemDetails (RFC 7807)
 */
interface ErrorResponse {
  success: false;
  statusCode: number;
  errorCode: string;
  message: string | string[];
  timestamp: string;
  path: string;
  requestId: string;
  /** Only present in development mode */
  detail?: string;
  /** Only present in development mode */
  stack?: string;
}

/**
 * Well-known PostgreSQL error codes → HTTP status mapping.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    code: 'UNIQUE_VIOLATION',
    message: 'A record with this value already exists',
  },
  '23503': {
    status: HttpStatus.BAD_REQUEST,
    code: 'FOREIGN_KEY_VIOLATION',
    message: 'Referenced record does not exist',
  },
  '23502': {
    status: HttpStatus.BAD_REQUEST,
    code: 'NOT_NULL_VIOLATION',
    message: 'A required field is missing',
  },
  '23514': {
    status: HttpStatus.BAD_REQUEST,
    code: 'CHECK_VIOLATION',
    message: 'A value violates a check constraint',
  },
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    code: 'INVALID_TEXT_REPRESENTATION',
    message: 'Invalid input syntax (e.g. malformed UUID)',
  },
  '22003': {
    status: HttpStatus.BAD_REQUEST,
    code: 'NUMERIC_VALUE_OUT_OF_RANGE',
    message: 'A numeric value is out of range',
  },
  '08006': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'CONNECTION_FAILURE',
    message: 'Database connection failed',
  },
  '08001': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'CONNECTION_UNABLE',
    message: 'Unable to establish database connection',
  },
  '40P01': {
    status: HttpStatus.CONFLICT,
    code: 'DEADLOCK_DETECTED',
    message: 'A database deadlock was detected, please retry',
  },
  '57014': {
    status: HttpStatus.GATEWAY_TIMEOUT,
    code: 'QUERY_TIMEOUT',
    message: 'The database query timed out',
  },
};

/**
 * Global Exception Filter
 *
 * Inspired by .NET's Exception Handling Middleware / ProblemDetails.
 * Catches every exception in the application and normalises it into a
 * consistent JSON error response.
 *
 * What it handles:
 *  1. NestJS HttpException family (400, 401, 403, 404, 409 …)
 *  2. Class-validator / ValidationPipe errors (400 with field-level messages)
 *  3. TypeORM QueryFailedError — mapped via PostgreSQL error codes
 *  4. TypeORM EntityNotFoundError → 404
 *  5. JSON SyntaxError (malformed body) → 400
 *  6. PayloadTooLargeError → 413
 *  7. Generic Error → 500
 *  8. Unknown throw (string, null …) → 500
 *
 * Every response carries a unique `requestId` for log correlation.
 * In development mode, `detail` and `stack` are included.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isDev: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isDev = this.configService.get<string>('nodeEnv') !== 'production';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) || randomUUID();

    const result = this.resolve(exception);

    // ── Logging ─────────────────────────────────────────────────────
    const tenantId = (request as any).user?.tenantId ?? 'anonymous';
    const userId = (request as any).user?.userId ?? 'anonymous';
    const logContext = `[${request.method}] ${request.url} | ${result.statusCode} | reqId=${requestId} | tenant=${tenantId} | user=${userId}`;

    if (result.statusCode >= 500) {
      // Server errors → full stack for investigation
      this.logger.error(
        `${logContext} | ${result.errorCode}: ${this.flat(result.message)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (result.statusCode >= 400) {
      // Client errors → warn level, no stack
      this.logger.warn(`${logContext} | ${result.errorCode}: ${this.flat(result.message)}`);
    }

    // ── Response ────────────────────────────────────────────────────
    const body: ErrorResponse = {
      success: false,
      statusCode: result.statusCode,
      errorCode: result.errorCode,
      message: result.message,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId,
    };

    if (this.isDev) {
      body.detail = result.detail;
      body.stack = exception instanceof Error ? exception.stack : undefined;
    }

    response.status(result.statusCode).json(body);
  }

  // ── Resolver ────────────────────────────────────────────────────────
  private resolve(exception: unknown): {
    statusCode: number;
    errorCode: string;
    message: string | string[];
    detail?: string;
  } {
    // ① NestJS HttpException (includes BadRequest, NotFound, Forbidden, etc.)
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    // ② TypeORM: QueryFailedError (unique violation, FK violation, etc.)
    if (exception instanceof QueryFailedError) {
      return this.fromQueryFailedError(exception);
    }

    // ③ TypeORM: EntityNotFoundError → 404
    if (exception instanceof EntityNotFoundError) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: 'ENTITY_NOT_FOUND',
        message: 'The requested resource was not found',
        detail: exception.message,
      };
    }

    // ④ Malformed JSON body
    if (exception instanceof SyntaxError && (exception as any).type === 'entity.parse.failed') {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: 'INVALID_JSON',
        message: 'Request body contains invalid JSON',
        detail: exception.message,
      };
    }

    // ⑤ Payload too large (Express/body-parser limit)
    if (exception instanceof Error && exception.name === 'PayloadTooLargeError') {
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        errorCode: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the maximum allowed size',
        detail: exception.message,
      };
    }

    // ⑥ Connection / timeout errors from upstream services
    if (exception instanceof Error) {
      const code = (exception as any).code as string | undefined;

      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          errorCode: 'UPSTREAM_UNAVAILABLE',
          message: 'A required service is currently unavailable',
          detail: exception.message,
        };
      }

      if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        return {
          statusCode: HttpStatus.GATEWAY_TIMEOUT,
          errorCode: 'UPSTREAM_TIMEOUT',
          message: 'A required service did not respond in time',
          detail: exception.message,
        };
      }
    }

    // ⑦ Generic Error → 500
    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        detail: exception.message,
      };
    }

    // ⑧ Non-Error throw (string, null, number …)
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'UNKNOWN_ERROR',
      message: 'An unexpected error occurred',
      detail: String(exception),
    };
  }

  // ── Sub-resolvers ───────────────────────────────────────────────────
  private fromHttpException(exception: HttpException): {
    statusCode: number;
    errorCode: string;
    message: string | string[];
    detail?: string;
  } {
    const status = exception.getStatus();
    const res = exception.getResponse();

    // ValidationPipe returns { message: string[], error: string, statusCode: number }
    if (typeof res === 'object' && res !== null) {
      const obj = res as Record<string, any>;
      return {
        statusCode: status,
        errorCode: this.httpStatusToCode(status, obj.error),
        message: obj.message ?? exception.message,
        detail: obj.error,
      };
    }

    return {
      statusCode: status,
      errorCode: this.httpStatusToCode(status),
      message: typeof res === 'string' ? res : exception.message,
    };
  }

  private fromQueryFailedError(exception: QueryFailedError): {
    statusCode: number;
    errorCode: string;
    message: string | string[];
    detail?: string;
  } {
    const pgCode = (exception as any).driverError?.code as string | undefined;
    const mapped = pgCode ? PG_ERROR_MAP[pgCode] : undefined;

    if (mapped) {
      // Extract the column/constraint name from the PG detail for richer messages
      const pgDetail = (exception as any).driverError?.detail as string | undefined;
      let message = mapped.message;

      if (pgCode === '23505' && pgDetail) {
        // e.g. "Key (email)=(foo@bar.com) already exists."
        const match = pgDetail.match(/Key \((.+?)\)=\((.+?)\)/);
        if (match) {
          message = `A record with ${match[1]} "${match[2]}" already exists`;
        }
      }

      return {
        statusCode: mapped.status,
        errorCode: mapped.code,
        message,
        detail: pgDetail || exception.message,
      };
    }

    // Unmapped PG error → 500
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'DATABASE_ERROR',
      message: 'A database error occurred',
      detail: exception.message,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  private httpStatusToCode(status: number, errorName?: string): string {
    if (errorName) {
      // "Bad Request" → "BAD_REQUEST", "Not Found" → "NOT_FOUND"
      return errorName.toUpperCase().replace(/\s+/g, '_');
    }

    const map: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
      [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
      [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
      [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
    };

    return map[status] ?? `HTTP_${status}`;
  }

  private flat(msg: string | string[]): string {
    return Array.isArray(msg) ? msg.join('; ') : msg;
  }
}
