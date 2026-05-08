import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookDispatcherService } from './webhook-dispatcher.service.js';

/**
 * Unit tests for WebhookDispatcherService.
 *
 * These focus on the routing logic: given a tenant + event, who gets called?
 * We stub `global.fetch` to observe outbound HTTP without opening real sockets.
 */

function makeRepos(opts: {
  hooks?: any[];
  tenant?: any;
  updateSpy?: ReturnType<typeof vi.fn>;
}) {
  const webhookRepo = {
    find: vi.fn().mockResolvedValue(opts.hooks ?? []),
    update: opts.updateSpy ?? vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const tenantRepo = {
    findOne: vi.fn().mockResolvedValue(opts.tenant ?? null),
  };
  return { webhookRepo, tenantRepo };
}

describe('WebhookDispatcherService', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    (global as any).fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires webhook for matching event only, with correct headers + signature', async () => {
    const hook = {
      id: 'wh-1',
      tenantId: 'tenant-1',
      url: 'https://example.com/hook',
      events: ['message.created'],
      isActive: true,
    };
    const updateSpy = vi.fn().mockResolvedValue({ affected: 1 });
    const { webhookRepo, tenantRepo } = makeRepos({ hooks: [hook], updateSpy });

    const svc = new WebhookDispatcherService(webhookRepo as any, tenantRepo as any);
    svc.emit('tenant-1', 'message.created', {
      conversationId: 'conv-1',
      userMessage: 'hi',
      assistantMessage: 'hello',
      tokensUsed: 42,
    });

    // emit is fire-and-forget; wait for microtask drain + promise chain
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Aisle-Event']).toBe('message.created');
    expect(init.headers['X-Aisle-Signature']).toMatch(/^sha256=/);
    expect(init.headers['X-Aisle-Delivery']).toBeTruthy();

    const body = JSON.parse(init.body as string);
    expect(body.event).toBe('message.created');
    expect(body.tenantId).toBe('tenant-1');
    expect(body.data.conversationId).toBe('conv-1');
    expect(body.data.tokensUsed).toBe(42);

    expect(updateSpy).toHaveBeenCalledWith('wh-1', expect.objectContaining({ lastFiredAt: expect.any(Date) }));
  });

  it('skips webhooks whose events list does not include the event', async () => {
    const hook = {
      id: 'wh-1',
      tenantId: 'tenant-1',
      url: 'https://example.com/hook',
      events: ['conversation.created'],
      isActive: true,
    };
    const { webhookRepo, tenantRepo } = makeRepos({ hooks: [hook] });

    const svc = new WebhookDispatcherService(webhookRepo as any, tenantRepo as any);
    svc.emit('tenant-1', 'message.created', { conversationId: 'conv-1' });

    await new Promise((r) => setTimeout(r, 20));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards to Slack when tenant has slack.webhookUrl configured', async () => {
    const tenant = {
      id: 'tenant-1',
      name: 'Acme',
      settings: { integrations: { slack: { webhookUrl: 'https://hooks.slack.com/services/XYZ' } } },
    };
    const { webhookRepo, tenantRepo } = makeRepos({ hooks: [], tenant });

    const svc = new WebhookDispatcherService(webhookRepo as any, tenantRepo as any);
    svc.emit('tenant-1', 'message.created', {
      conversationId: 'c1',
      userMessage: 'ping',
      assistantMessage: 'pong',
      tokensUsed: 12,
      model: 'gpt-4o-mini',
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/XYZ');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('Acme');
    expect(body.text).toContain('ping');
    expect(body.text).toContain('pong');
  });

  it('retries on transient failure and marks lastFiredAt on eventual success', async () => {
    const hook = {
      id: 'wh-2',
      tenantId: 'tenant-1',
      url: 'https://example.com/flaky',
      events: ['assistant.error'],
      isActive: true,
    };
    const updateSpy = vi.fn().mockResolvedValue({ affected: 1 });
    const { webhookRepo, tenantRepo } = makeRepos({ hooks: [hook], updateSpy });

    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'err' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'ok' });
    (global as any).fetch = fetchSpy;

    const svc = new WebhookDispatcherService(webhookRepo as any, tenantRepo as any);
    svc.emit('tenant-1', 'assistant.error', { conversationId: 'c1', error: 'boom' });

    await new Promise((r) => setTimeout(r, 600));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fire when no active webhooks and no Slack configured', async () => {
    const { webhookRepo, tenantRepo } = makeRepos({ hooks: [], tenant: { id: 't', name: 'N', settings: {} } });
    const svc = new WebhookDispatcherService(webhookRepo as any, tenantRepo as any);
    svc.emit('tenant-1', 'conversation.created', { conversationId: 'c1' });

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
