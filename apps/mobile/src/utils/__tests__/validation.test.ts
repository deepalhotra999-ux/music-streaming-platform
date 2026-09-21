// Phase 5 — form validation unit tests.

import {
  hasErrors,
  validateDisplayName,
  validateEmail,
  validateLoginForm,
  validateLoginPassword,
  validatePassword,
  validateRegisterForm,
} from '../validation';

describe('validateEmail', () => {
  it('accepts a normal address', () => {
    expect(validateEmail('fan@example.com')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(validateEmail('  fan@example.com  ')).toBeNull();
  });

  it.each(['', '   '])('rejects blank input %j', (value) => {
    expect(validateEmail(value)).toBe('Email is required.');
  });

  it.each(['not-an-email', 'a@b', 'a b@c.com', '@c.com'])('rejects %j', (value) => {
    expect(validateEmail(value)).toBe('Enter a valid email address.');
  });
});

describe('validatePassword', () => {
  it('accepts a 12+ character password', () => {
    expect(validatePassword('correct-horse-1')).toBeNull();
  });

  it('rejects blank and short passwords', () => {
    expect(validatePassword('')).toBe('Password is required.');
    expect(validatePassword('short-123')).toBe('Password must be at least 12 characters.');
  });

  it('rejects over-long passwords', () => {
    expect(validatePassword('a'.repeat(129))).toBe('Password must be at most 128 characters.');
  });
});

describe('validateLoginPassword', () => {
  it('accepts any non-empty password', () => {
    expect(validateLoginPassword('x')).toBeNull();
    expect(validateLoginPassword('')).toBe('Password is required.');
  });
});

describe('validateDisplayName', () => {
  it('accepts a normal name', () => {
    expect(validateDisplayName('Ada')).toBeNull();
  });

  it('rejects blank and over-long names', () => {
    expect(validateDisplayName('   ')).toBe('Display name is required.');
    expect(validateDisplayName('a'.repeat(101))).toBe('Display name must be at most 100 characters.');
  });
});

describe('validateLoginForm / validateRegisterForm', () => {
  it('returns no errors for valid login input', () => {
    expect(validateLoginForm('fan@example.com', 'anything')).toEqual({});
  });

  it('collects all login field errors at once', () => {
    expect(validateLoginForm('bad', '')).toEqual({
      email: 'Enter a valid email address.',
      password: 'Password is required.',
    });
  });

  it('returns no errors for valid registration input', () => {
    expect(validateRegisterForm('Ada', 'ada@example.com', 'twelve-chars!!')).toEqual({});
  });

  it('enforces the 12-char password policy on registration', () => {
    const errors = validateRegisterForm('Ada', 'ada@example.com', 'short');
    expect(errors.password).toBe('Password must be at least 12 characters.');
  });

  it('hasErrors detects any present error', () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ email: undefined })).toBe(false);
    expect(hasErrors({ email: 'bad' })).toBe(true);
  });
});
