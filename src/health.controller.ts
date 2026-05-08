import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';

/**
 * Health Controller
 * Provides health check endpoint for container orchestration.
 */
@Controller()
export class HealthController {
  /**
   * Health check endpoint
   * GET /health
   *
   * Returns only `{ status: 'ok' }` — uptime/timestamp/version are
   * deliberately omitted because unauthenticated callers can use that
   * data for attack timing and fingerprinting.
   */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /**
   * Root endpoint
   * GET /
   *
   * Returns 204 No Content. Do not advertise product name, version, or
   * docs path on the public root — that's gratuitous fingerprinting
   * fodder and any legitimate caller already knows what they're hitting.
   */
  @Public()
  @Get()
  @HttpCode(HttpStatus.NO_CONTENT)
  root(): void {
    return;
  }
}
