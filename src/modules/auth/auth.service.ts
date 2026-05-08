import { Injectable, UnauthorizedException, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { hashPassword, verifyPassword } from '../../common/utils/password.util';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../../database/entities/user.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { getPlanLimits } from '../../common/constants/plan-limits';
import { PlansService } from '../plans/plans.service';

import { RegisterDto, LoginDto, RefreshTokenDto, AuthResponse } from './dto/auth.dto';
import { JwtPayload, UserRole } from '../../common/interfaces/tenant-context.interface';

/**
 * Authentication Service
 * Handles user registration, login, and token management.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly plansService: PlansService,
  ) { }

  /**
   * Register a new user
   * If tenantSlug is not provided, creates a new tenant
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    // Pre-validate outside transaction to fail fast
    if (dto.tenantSlug) {
      const foundTenant = await this.tenantRepository.findOne({
        where: { slug: dto.tenantSlug },
      });
      if (!foundTenant) {
        throw new NotFoundException(`Tenant with slug "${dto.tenantSlug}" not found`);
      }
    }

    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException(
        dto.tenantSlug
          ? 'This email already has a role in this organization. Each email can only be assigned one role per organization.'
          : 'This email is already registered. Each email can only be associated with one account.',
      );
    }

    // Hash password outside transaction (CPU-intensive)
    const passwordHash = await hashPassword(dto.password);

    // Run tenant creation + user creation atomically in a transaction
    const { user, tenant } = await this.dataSource.transaction(async (manager) => {
      let txTenant: Tenant;

      if (dto.tenantSlug) {
        // Join existing tenant
        const foundTenant = await manager.findOne(Tenant, {
          where: { slug: dto.tenantSlug },
        });
        if (!foundTenant) {
          throw new NotFoundException(`Tenant with slug "${dto.tenantSlug}" not found`);
        }
        txTenant = foundTenant;

        // Check against central limits to enforce plan logic
        const limits = getPlanLimits(txTenant.plan);
        const maxUsers = limits.maxUsers;

        const currentUsers = await manager.count(User, { where: { tenantId: txTenant.id } });
        if (currentUsers >= maxUsers) {
          throw new ForbiddenException(`This organization's plan (${txTenant.plan}) limits to ${maxUsers} user(s). Please ask the admin to upgrade.`);
        }
      } else {
        // Create new tenant — assign whichever plan the platform admin has
        // marked as the entry-level tier (cheapest active plan). Fail loudly
        // if no plans are configured yet so the platform owner notices.
        const defaultPlanCode = await this.plansService.getDefaultPlanCodeForNewTenant();
        if (!defaultPlanCode) {
          throw new ForbiddenException(
            'Sign-up is unavailable: no subscription plans are configured. ' +
            'Ask the platform administrator to set up plans at /super-admin/plans.',
          );
        }

        const tenantName = dto.tenantName || `${dto.name}'s Organization`;
        const tenantSlug = this.generateSlug(tenantName);

        const existingTenant = await manager.findOne(Tenant, {
          where: { slug: tenantSlug },
        });
        if (existingTenant) {
          throw new ConflictException(`Tenant slug "${tenantSlug}" already exists`);
        }

        txTenant = manager.create(Tenant, {
          name: tenantName,
          slug: tenantSlug,
          plan: defaultPlanCode,
          settings: {},
        });
        await manager.save(txTenant);
      }

      // Re-check uniqueness within transaction to prevent race conditions
      const duplicateUser = await manager.findOne(User, {
        where: { email: dto.email },
      });
      if (duplicateUser) {
        throw new ConflictException(
          dto.tenantSlug
            ? 'This email already has a role in this organization. Each email can only be assigned one role per organization.'
            : 'This email is already registered. Each email can only be associated with one account.',
        );
      }

      // Create user (first user in new tenant is owner)
      const isFirstUser = !dto.tenantSlug;
      const txUser = manager.create(User, {
        tenantId: txTenant.id,
        email: dto.email,
        passwordHash,
        name: dto.name,
        role: isFirstUser ? UserRole.TENANT_OWNER : UserRole.USER,
      });
      await manager.save(txUser);

      return { user: txUser, tenant: txTenant };
    });

    // Generate tokens (outside transaction — read-only)
    return this.generateAuthResponse(user, tenant);
  }

  /**
   * Login user
   */
  async login(dto: LoginDto): Promise<AuthResponse> {
    let tenant: Tenant | null = null;
    let user: User | null = null;

    if (dto.tenantSlug) {
      // Find tenant by slug
      tenant = await this.tenantRepository.findOne({
        where: { slug: dto.tenantSlug },
      });
      if (!tenant) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Find user in that tenant
      user = await this.userRepository.findOne({
        where: { tenantId: tenant.id, email: dto.email },
      });
    } else {
      // No tenantSlug provided — find user by email (pick the first match)
      user = await this.userRepository.findOne({
        where: { email: dto.email },
      });
      if (user) {
        tenant = await this.tenantRepository.findOne({
          where: { id: user.tenantId },
        });
      }
    }

    if (!user || !tenant) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await verifyPassword(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is active
    if (!user.isActive) {
      throw new UnauthorizedException('User account is disabled');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    // Generate tokens
    return this.generateAuthResponse(user, tenant);
  }

  /**
   * Refresh access token
   */
  async refreshToken(dto: RefreshTokenDto): Promise<AuthResponse> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(dto.refreshToken, {
        secret: this.configService.get<string>('jwt.secret'),
      });

      // Find user
      const user = await this.userRepository.findOne({
        where: { id: payload.sub, tenantId: payload.tenantId },
      });
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const tenant = await this.tenantRepository.findOne({
        where: { id: payload.tenantId },
      });
      if (!tenant) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return this.generateAuthResponse(user, tenant);
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /**
   * Generate JWT tokens and auth response
   */
  private async generateAuthResponse(user: User, tenant: Tenant): Promise<AuthResponse> {
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: tenant.id,
      email: user.email,
      role: user.role,
      priority: user.priority,
    };

    const accessToken = await this.jwtService.signAsync(payload as object);
    const refreshToken = await this.jwtService.signAsync(payload as object, {
      expiresIn: this.configService.get<string>('jwt.refreshExpiresIn') || '7d',
    } as any);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.get<string>('jwt.expiresIn') || '1d',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        priority: user.priority,
        tenantId: tenant.id,
        tenantName: tenant.name,
        profilePhotoUrl: user.profilePhotoUrl || null,
      },
    };
  }

  /**
   * Generate URL-safe slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) + '-' + uuidv4().substring(0, 8);
  }
}
