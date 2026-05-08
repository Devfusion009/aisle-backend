import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHmac, randomUUID } from 'crypto';
import { Webhook } from '../../database/entities/webhook.entity';
import { Tenant } from '../../database/entities/tenant.entity';

export type IntegrationEvent =
  | 'conversation.created'
  | 'conversation.closed'
  | 'message.created'
  | 'assistant.error';

export interface EventPayload {
  conversationId?: string;
  messageId?: string;
  userMessage?: string;
  assistantMessage?: string;
  model?: string;
  tokensUsed?: number;
  error?: string;
  [k: string]: unknown;
}

interface DeliveryAttempt {
  webhookId: string;
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
}

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly signingSecret =
    process.env.WEBHOOK_SIGNING_SECRET ?? 'aisle-webhook-default-secret';
  private readonly maxAttempts = 3;
  private readonly timeoutMs = 5000;

  constructor(
    @InjectRepository(Webhook) private readonly webhookRepo: Repository<Webhook>,
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
  ) {}

  /**
   * Emit an integration event for a tenant. Fires matching user-registered
   * webhooks AND pushes a formatted message to the tenant's Slack webhook if
   * configured. Fire-and-forget from the caller's perspective — never throws.
   */
  emit(tenantId: string, event: IntegrationEvent, payload: EventPayload): void {
    void this.emitAsync(tenantId, event, payload).catch((err) => {
      this.logger.warn(`emit(${event}) failed for tenant ${tenantId}: ${err?.message ?? err}`);
    });
  }

  private async emitAsync(
    tenantId: string,
    event: IntegrationEvent,
    payload: EventPayload,
  ): Promise<DeliveryAttempt[]> {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const body = { id: eventId, event, tenantId, timestamp, data: payload };

    const [hooks, tenant] = await Promise.all([
      this.webhookRepo.find({ where: { tenantId, isActive: true } }),
      this.tenantRepo.findOne({ where: { id: tenantId } }),
    ]);

    const matching = hooks.filter((h) => (h.events ?? []).includes(event));
    const slackUrl = tenant?.settings?.integrations?.slack?.webhookUrl;

    const tasks: Promise<DeliveryAttempt>[] = matching.map((h) =>
      this.deliverWebhook(h, body),
    );

    if (slackUrl) {
      tasks.push(
        this.deliverSlack(slackUrl, tenant!.name ?? 'Aisle', event, payload).then((r) => ({
          webhookId: 'slack',
          url: slackUrl,
          status: r.status,
          ok: r.ok,
          error: r.error,
        })),
      );
    }

    const results = await Promise.all(tasks);
    return results;
  }

  private async deliverWebhook(
    hook: Webhook,
    body: Record<string, unknown>,
  ): Promise<DeliveryAttempt> {
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', this.signingSecret).update(raw).digest('hex');
    let lastError: string | undefined;
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Aisle-Webhook/1.0',
            'X-Aisle-Event': String(body.event),
            'X-Aisle-Delivery': String(body.id),
            'X-Aisle-Signature': `sha256=${signature}`,
          },
          body: raw,
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        lastStatus = res.status;
        if (res.ok) {
          await this.webhookRepo.update(hook.id, { lastFiredAt: new Date() });
          return { webhookId: hook.id, url: hook.url, status: res.status, ok: true };
        }
        lastError = `HTTP ${res.status}`;
      } catch (err: any) {
        lastError = err?.message ?? 'Network error';
      }

      if (attempt < this.maxAttempts) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
      }
    }

    this.logger.warn(
      `Webhook ${hook.id} (${hook.url}) failed after ${this.maxAttempts} attempts: ${lastError}`,
    );
    return { webhookId: hook.id, url: hook.url, status: lastStatus, ok: false, error: lastError };
  }

  private async deliverSlack(
    url: string,
    tenantName: string,
    event: IntegrationEvent,
    payload: EventPayload,
  ): Promise<{ ok: boolean; status: number | null; error?: string }> {
    const text = this.formatSlackText(tenantName, event, payload);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `Slack ${res.status}: ${body}` };
      }
      return { ok: true, status: res.status };
    } catch (err: any) {
      return { ok: false, status: null, error: err?.message ?? 'Slack network error' };
    }
  }

  private formatSlackText(
    tenantName: string,
    event: IntegrationEvent,
    p: EventPayload,
  ): string {
    const trim = (s: string | undefined, n = 300) => {
      if (!s) return '';
      const t = s.replace(/\s+/g, ' ').trim();
      return t.length > n ? t.slice(0, n) + '…' : t;
    };

    switch (event) {
      case 'conversation.created':
        return `:speech_balloon: *${tenantName}* — new conversation started${p.conversationId ? ` \`${p.conversationId}\`` : ''}.`;
      case 'conversation.closed':
        return `:lock: *${tenantName}* — conversation closed${p.conversationId ? ` \`${p.conversationId}\`` : ''}.`;
      case 'message.created': {
        const u = trim(p.userMessage);
        const a = trim(p.assistantMessage);
        const tokens = typeof p.tokensUsed === 'number' ? ` _(${p.tokensUsed} tokens${p.model ? `, ${p.model}` : ''})_` : '';
        const parts = [`:robot_face: *${tenantName}* — new message${tokens}`];
        if (u) parts.push(`> *User:* ${u}`);
        if (a) parts.push(`> *Assistant:* ${a}`);
        return parts.join('\n');
      }
      case 'assistant.error':
        return `:warning: *${tenantName}* — assistant error: \`${trim(p.error, 500) || 'unknown error'}\`${p.conversationId ? ` (conversation \`${p.conversationId}\`)` : ''}`;
    }
  }
}
