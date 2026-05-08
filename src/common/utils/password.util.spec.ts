import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateSecurePassword,
  PASSWORD_REGEX,
  BCRYPT_ROUNDS,
} from './password.util.js';

describe('password.util', () => {
  describe('hashPassword', () => {
    it('should return a bcrypt hash string', async () => {
      const hash = await hashPassword('Test@1234');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      // bcrypt hashes start with $2b$ (or $2a$)
      expect(hash).toMatch(/^\$2[ab]\$/);
    });

    it('should produce different hashes for the same input (due to salt)', async () => {
      const hash1 = await hashPassword('Test@1234');
      const hash2 = await hashPassword('Test@1234');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('should return true for a correct password', async () => {
      const plaintext = 'MyP@ssword1';
      const hash = await hashPassword(plaintext);
      const result = await verifyPassword(plaintext, hash);
      expect(result).toBe(true);
    });

    it('should return false for a wrong password', async () => {
      const hash = await hashPassword('CorrectP@ss1');
      const result = await verifyPassword('WrongP@ss1', hash);
      expect(result).toBe(false);
    });
  });

  describe('generateSecurePassword', () => {
    it('should generate a 12-character password', () => {
      const password = generateSecurePassword();
      expect(password).toHaveLength(12);
    });

    it('should satisfy the PASSWORD_REGEX policy', () => {
      // Generate multiple to reduce flakiness
      for (let i = 0; i < 20; i++) {
        const password = generateSecurePassword();
        expect(password).toMatch(PASSWORD_REGEX);
      }
    });
  });

  describe('PASSWORD_REGEX', () => {
    it('should accept valid passwords', () => {
      expect(PASSWORD_REGEX.test('Abcdef1!')).toBe(true);
      expect(PASSWORD_REGEX.test('MyP@ssw0rd')).toBe(true);
      expect(PASSWORD_REGEX.test('Str0ng!Pass')).toBe(true);
    });

    it('should reject passwords without uppercase', () => {
      expect(PASSWORD_REGEX.test('abcdef1!')).toBe(false);
    });

    it('should reject passwords without lowercase', () => {
      expect(PASSWORD_REGEX.test('ABCDEF1!')).toBe(false);
    });

    it('should reject passwords without digit', () => {
      expect(PASSWORD_REGEX.test('Abcdefg!')).toBe(false);
    });

    it('should reject passwords without special character', () => {
      expect(PASSWORD_REGEX.test('Abcdefg1')).toBe(false);
    });

    it('should reject passwords shorter than 8 characters', () => {
      expect(PASSWORD_REGEX.test('Ab1!xyz')).toBe(false);
    });
  });

  describe('BCRYPT_ROUNDS', () => {
    it('should be 12', () => {
      expect(BCRYPT_ROUNDS).toBe(12);
    });
  });
});
