import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RefreshTokenDto, AuthResponse } from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Authentication Controller
 * Handles public auth endpoints for login and token refresh.
 * Registration has been replaced by the Access Request flow.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * User login
   * POST /auth/login
   *
   * Hard rate-limited to mitigate password brute-force: 5 attempts per
   * minute per IP. Hitting the cap returns HTTP 429 (ThrottlerException).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<AuthResponse> {
    return this.authService.login(dto);
  }

  /**
   * Refresh access token
   * POST /auth/refresh
   *
   * Rate-limited to slow down stolen-token-replay or refresh-spam:
   * 20 refreshes per minute per IP.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponse> {
    return this.authService.refreshToken(dto);
  }
}
