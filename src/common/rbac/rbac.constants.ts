import { UserRole } from '../interfaces/tenant-context.interface';

/**
 * Role hierarchy — higher number = more authority.
 * PLATFORM_ADMIN > TENANT_OWNER > TENANT_ADMIN > EDITOR > USER
 */
export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.USER]: 1,
  [UserRole.EDITOR]: 2,
  [UserRole.TENANT_ADMIN]: 3,
  [UserRole.TENANT_OWNER]: 4,
  [UserRole.PLATFORM_ADMIN]: 5,
};

/**
 * Fine-grained permissions. Every controller action maps to one of these.
 * Role → permission mapping lives in ROLE_PERMISSIONS below.
 */
export enum Permission {
  // Platform
  PLATFORM_MANAGE       = 'platform:manage',

  // Tenant
  TENANT_MANAGE         = 'tenant:manage',
  TENANT_SETTINGS_VIEW  = 'tenant:settings:view',

  // Users (inside a tenant)
  USER_MANAGE           = 'user:manage',

  // Assistants
  ASSISTANT_READ        = 'assistant:read',
  ASSISTANT_MANAGE      = 'assistant:manage',

  // Knowledge base
  KB_READ               = 'kb:read',
  KB_WRITE              = 'kb:write',
  KB_GRANT              = 'kb:grant',

  // Chat / conversations
  CHAT_USE              = 'chat:use',
  CONVERSATION_MANAGE   = 'conversation:manage',

  // Admin surfaces
  API_KEY_MANAGE        = 'apikey:manage',
  INTEGRATION_MANAGE    = 'integration:manage',
  BILLING_VIEW          = 'billing:view',
  ANALYTICS_VIEW        = 'analytics:view',
  PLAYGROUND_USE        = 'playground:use',
  DASHBOARD_VIEW        = 'dashboard:view',
}

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.PLATFORM_ADMIN]: [
    Permission.PLATFORM_MANAGE,
    Permission.TENANT_SETTINGS_VIEW,
  ],
  [UserRole.TENANT_OWNER]: [
    Permission.TENANT_MANAGE, Permission.TENANT_SETTINGS_VIEW,
    Permission.USER_MANAGE,
    Permission.ASSISTANT_READ, Permission.ASSISTANT_MANAGE,
    Permission.KB_READ, Permission.KB_WRITE, Permission.KB_GRANT,
    Permission.CHAT_USE, Permission.CONVERSATION_MANAGE,
    Permission.API_KEY_MANAGE, Permission.INTEGRATION_MANAGE,
    Permission.BILLING_VIEW, Permission.ANALYTICS_VIEW,
    Permission.PLAYGROUND_USE, Permission.DASHBOARD_VIEW,
  ],
  [UserRole.TENANT_ADMIN]: [
    Permission.TENANT_SETTINGS_VIEW,
    Permission.USER_MANAGE,
    Permission.ASSISTANT_READ, Permission.ASSISTANT_MANAGE,
    Permission.KB_READ, Permission.KB_WRITE, Permission.KB_GRANT,
    Permission.CHAT_USE, Permission.CONVERSATION_MANAGE,
    Permission.API_KEY_MANAGE, Permission.INTEGRATION_MANAGE,
    Permission.BILLING_VIEW, Permission.ANALYTICS_VIEW,
    Permission.PLAYGROUND_USE, Permission.DASHBOARD_VIEW,
  ],
  [UserRole.EDITOR]: [
    // Editor consumes assistants (via /chat) but cannot manage them.
    Permission.ASSISTANT_READ,
    Permission.KB_READ, Permission.KB_WRITE, Permission.KB_GRANT,
    Permission.CHAT_USE,
    Permission.PLAYGROUND_USE,
  ],
  [UserRole.USER]: [
    Permission.ASSISTANT_READ,
    Permission.CHAT_USE,
    // KB_READ is NOT granted here — regular users read KB only via
    // explicit grant + priority='high', enforced by KbPermissionGuard.
  ],
};

export function roleAtLeast(have: UserRole, min: UserRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[min];
}

export function roleHas(role: UserRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}
