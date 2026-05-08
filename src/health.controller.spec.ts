import { describe, it, expect, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController();
  });

  describe('health()', () => {
    it('should return status ok with no extra fields', () => {
      const result = controller.health();
      // Uptime/timestamp/version intentionally omitted — they leak
      // attack-timing and fingerprinting data to unauthenticated probes.
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('root()', () => {
    it('should return nothing (204 No Content set via @HttpCode)', () => {
      const result = controller.root();
      expect(result).toBeUndefined();
    });
  });
});
