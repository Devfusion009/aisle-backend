import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark an endpoint as publicly accessible (no auth required)
 * 
 * Usage:
 * ```typescript
 * @Public()
 * @Get('health')
 * healthCheck() { }
 * ```
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
