import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { UserRole } from '../../common/interfaces/tenant-context.interface.js';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: Partial<AuthService>;

  const mockAuthResponse = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: '1d',
    user: {
      id: 'u1',
      email: 'test@example.com',
      name: 'Test',
      role: UserRole.TENANT_OWNER,
      tenantId: 't1',
      tenantName: 'Org',
      profilePhotoUrl: null,
    },
  };

  beforeEach(() => {
    authService = {
      login: vi.fn().mockResolvedValue(mockAuthResponse),
      refreshToken: vi.fn().mockResolvedValue(mockAuthResponse),
    };

    controller = new AuthController(authService as AuthService);
  });

  describe('login()', () => {
    it('should delegate to authService.login and return the result', async () => {
      const dto = { email: 'test@example.com', password: 'P@ss1234' };
      const result = await controller.login(dto);

      expect(authService.login).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('refresh()', () => {
    it('should delegate to authService.refreshToken and return the result', async () => {
      const dto = { refreshToken: 'old-refresh' };
      const result = await controller.refresh(dto);

      expect(authService.refreshToken).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockAuthResponse);
    });
  });
});
