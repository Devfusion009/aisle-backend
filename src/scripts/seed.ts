import { DataSource } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { UserRole } from '../common/interfaces/tenant-context.interface';
import { Assistant, LLMProvider } from '../database/entities/assistant.entity';
import { hashPassword } from '../common/utils/password.util';
import * as dotenv from 'dotenv';

dotenv.config();

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5433'),
  username: process.env.DATABASE_USERNAME || 'aisle',
  password: process.env.DATABASE_PASSWORD || 'aisle_secret',
  database: process.env.DATABASE_NAME || 'aisle_db',
  entities: [Tenant, User, Assistant],
  synchronize: false,
});

async function seed() {
  await dataSource.initialize();
  console.log('Data Source initialized');

  const tenantRepo = dataSource.getRepository(Tenant);
  const userRepo = dataSource.getRepository(User);
  const assistantRepo = dataSource.getRepository(Assistant);

  // 1. Create System Tenant and Platform Admin
  const systemTenantSlug = 'system';
  let systemTenant = await tenantRepo.findOne({ where: { slug: systemTenantSlug } });
  if (!systemTenant) {
    systemTenant = tenantRepo.create({
      name: 'System Administration',
      slug: systemTenantSlug,
      settings: {},
      isActive: true,
    });
    await tenantRepo.save(systemTenant);
    console.log(`Created System Tenant: ${systemTenant.name} (${systemTenant.id})`);
  }

  // Platform Admin: platform@verse.ai
  const platformAdminEmail = 'platform@verse.ai';
  let platformAdmin = await userRepo.findOne({ where: { email: platformAdminEmail } });
  if (!platformAdmin) {
    const passwordHash = await hashPassword('password123');

    platformAdmin = userRepo.create({
      tenantId: systemTenant.id,
      email: platformAdminEmail,
      name: 'Platform Admin',
      passwordHash,
      role: UserRole.PLATFORM_ADMIN,
      isActive: true,
    });
    await userRepo.save(platformAdmin);
    console.log(`Created Platform Admin: ${platformAdmin.email} (Password: password123)`);
  } else {
    console.log(`Platform Admin ${platformAdminEmail} already exists`);
  }

  // 2. Create Acme Corp Tenant
  // No per-tenant limit overrides — all limits come from the subscription_plans
  // table, configured by the platform admin via /super-admin/plans.
  const tenantSlug = 'acme';
  let tenant = await tenantRepo.findOne({ where: { slug: tenantSlug } });
  if (!tenant) {
    tenant = tenantRepo.create({
      name: 'Acme Corp',
      slug: tenantSlug,
      plan: 'starter',
      settings: {},
      isActive: true,
    });
    await tenantRepo.save(tenant);
    console.log(`Created Tenant: ${tenant.name} (${tenant.id})`);
  } else {
    console.log(`Tenant Acme Corp already exists`);
  }

  // 3. Create demo users for Acme Corp

  // Tenant Owner: carlos@acme.com
  const ownerEmail = 'carlos@acme.com';
  let owner = await userRepo.findOne({ where: { email: ownerEmail } });
  if (!owner) {
    const passwordHash = await hashPassword('password123');

    owner = userRepo.create({
      tenantId: tenant.id,
      email: ownerEmail,
      name: 'Carlos Owner',
      passwordHash,
      role: UserRole.TENANT_OWNER,
      isActive: true,
    });
    await userRepo.save(owner);
    console.log(`Created Tenant Owner: ${owner.email} (Password: password123)`);
  } else {
    console.log(`User ${ownerEmail} already exists`);
  }

  // Tenant Admin: admin@acme.com
  const adminEmail = 'admin@acme.com';
  let admin = await userRepo.findOne({ where: { email: adminEmail } });
  if (!admin) {
    const passwordHash = await hashPassword('password123');

    admin = userRepo.create({
      tenantId: tenant.id,
      email: adminEmail,
      name: 'Admin User',
      passwordHash,
      role: UserRole.TENANT_ADMIN,
      isActive: true,
    });
    await userRepo.save(admin);
    console.log(`Created Tenant Admin: ${admin.email} (Password: password123)`);
  } else {
    console.log(`User ${adminEmail} already exists`);
  }

  // Editor: maria@acme.com
  const editorEmail = 'maria@acme.com';
  let editor = await userRepo.findOne({ where: { email: editorEmail } });
  if (!editor) {
    const passwordHash = await hashPassword('password123');

    editor = userRepo.create({
      tenantId: tenant.id,
      email: editorEmail,
      name: 'Maria Editor',
      passwordHash,
      role: UserRole.EDITOR,
      isActive: true,
    });
    await userRepo.save(editor);
    console.log(`Created Editor: ${editor.email} (Password: password123)`);
  } else {
    console.log(`User ${editorEmail} already exists`);
  }

  // User: joao@acme.com
  const userEmail = 'joao@acme.com';
  let regularUser = await userRepo.findOne({ where: { email: userEmail } });
  if (!regularUser) {
    const passwordHash = await hashPassword('password123');

    regularUser = userRepo.create({
      tenantId: tenant.id,
      email: userEmail,
      name: 'João User',
      passwordHash,
      role: UserRole.USER,
      isActive: true,
    });
    await userRepo.save(regularUser);
    console.log(`Created User: ${regularUser.email} (Password: password123)`);
  } else {
    console.log(`User ${userEmail} already exists`);
  }

  // 4. Create Sample Assistant
  const assistantName = 'Research Assistant';
  let assistant = await assistantRepo.findOne({ where: { name: assistantName, tenantId: tenant.id } });
  if (!assistant) {
    assistant = assistantRepo.create({
      tenantId: tenant.id,
      name: assistantName,
      description: 'A helpful assistant for researching documents.',
      systemPrompt: 'You are a helpful research assistant. Use the provided context to answer questions.',
      provider: LLMProvider.OPENAI,
      model: 'gpt-4o-mini',
      temperature: 0.7,
      ragEnabled: true,
      isActive: true,
    });
    await assistantRepo.save(assistant);
    console.log(`Created Assistant: ${assistant.name}`);
  } else {
    console.log(`Assistant ${assistantName} already exists`);
  }

  await dataSource.destroy();
}

seed().catch((error) => {
  console.error('Error seeding data:', error);
  process.exit(1);
});
