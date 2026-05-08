import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

/**
 * bcrypt cost factor – 12 rounds is the modern recommended minimum.
 * Increase to 13-14 for higher security environments (at the cost of latency).
 */
export const BCRYPT_ROUNDS = 12;

/**
 * Password policy regex:
 * - At least 8 characters
 * - At least one uppercase letter (A-Z)
 * - At least one lowercase letter (a-z)
 * - At least one digit (0-9)
 * - At least one special character
 */
export const PASSWORD_REGEX =
  /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,128}$/;

export const PASSWORD_VALIDATION_MESSAGE =
  'Password must be 8–128 characters and include at least one uppercase letter, one lowercase letter, one number, and one special character.';

/**
 * Hashes a plaintext password using bcrypt with the standard cost factor.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/**
 * Compares a plaintext password against a bcrypt hash.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Generates a cryptographically secure random password that satisfies the
 * password policy (uppercase, lowercase, digit, special char, 12 chars total).
 * Uses crypto.randomBytes instead of Math.random to ensure unpredictability.
 */
export function generateSecurePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  const pick = (charset: string): string => {
    const idx = randomBytes(1)[0] % charset.length;
    return charset[idx];
  };

  // Guarantee at least one character from each required category
  const mandatory = [pick(upper), pick(lower), pick(digits), pick(special)];

  // Fill remaining 8 characters from the full set
  const rest = Array.from({ length: 8 }, () => pick(all));

  // Shuffle using Fisher-Yates with cryptographically secure indices
  const chars = [...mandatory, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}
