import { describe, expect, it } from 'vitest';
import { argon2Available, hashPassword, verifyPassword } from './password.js';

// Small parameters keep the test fast; production defaults are in DEFAULT_ARGON2.
const fast = { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 };

describe('argon2id password hashing', () => {
  it('is available in this Node build', () => {
    expect(argon2Available()).toBe(true);
  });

  it('produces a PHC string and verifies the right password only', () => {
    const phc = hashPassword('correct horse battery staple', fast);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(verifyPassword('correct horse battery staple', phc)).toBe(true);
    expect(verifyPassword('wrong', phc)).toBe(false);
  });

  it('salts every hash', () => {
    expect(hashPassword('x', fast)).not.toBe(hashPassword('x', fast));
  });

  it('rejects malformed hashes without throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', '$scrypt$foo')).toBe(false);
  });
});
