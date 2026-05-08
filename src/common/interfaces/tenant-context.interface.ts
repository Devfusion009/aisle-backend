/**
 * Tenant Context Interface
 * Represents the resolved tenant context for every authenticated request.
 * This is the core of multi-tenancy - all operations must be scoped to this context.
 */
export interface TenantContext {
  /** Unique identifier for the tenant (organization) */
  tenantId: string;

  /** Unique identifier for the authenticated user */
  userId: string;

  /** User's role within the tenant */
  role: UserRole;

  /** User's email for reference */
  email: string;

  /** User's priority level (high/low) */
  priority?: string;
}

/**
 * User roles for RBAC (hierarchical)
 * PLATFORM_ADMIN > TENANT_OWNER > TENANT_ADMIN > EDITOR > USER
 */
export enum UserRole {
  /** Platform Admin - can manage all tenants and users across the platform */
  PLATFORM_ADMIN = 'platform_admin',

  /** Tenant Owner - owns a tenant org, full control within the tenant */
  TENANT_OWNER = 'tenant_owner',

  /** Tenant Admin - can manage tenant settings, users, assistants, knowledge bases */
  TENANT_ADMIN = 'tenant_admin',

  /** Editor - can manage assistants and knowledge bases (no user/settings management) */
  EDITOR = 'editor',

  /** User (Usuário) - can only use assistants (chat) */
  USER = 'user',
}

/**
 * JWT Payload structure
 */
export interface JwtPayload {
  sub: string;        // User ID
  tenantId: string;   // Tenant ID
  email: string;      // User email
  role: UserRole;     // User role
  priority?: string;  // User priority (high/low)
  iat?: number;       // Issued at
  exp?: number;       // Expiration
}

/**
 * Authenticated request with tenant context
 */
export interface AuthenticatedRequest extends Request {
  user: TenantContext;
}
