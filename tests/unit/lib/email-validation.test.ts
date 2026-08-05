import { describe, expect, it } from 'vitest';
import {
  isDisposableEmailDomain,
  isValidEmailAddress,
  normalizeEmail,
} from '@/lib/email-validation';

describe('normalizeEmail', () => {
  it.each([
    ['  Foo@Example.COM  ', 'foo@example.com'],
    ['USER@DOMAIN.IO', 'user@domain.io'],
    ['\tuser@domain.io\n', 'user@domain.io'],
    ['already@lower.com', 'already@lower.com'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('does not strip internal whitespace', () => {
    expect(normalizeEmail('a b@example.com')).toBe('a b@example.com');
  });
});

describe('isValidEmailAddress', () => {
  it.each([
    'a@b.co',
    'user@example.com',
    'user.name+tag@sub.example.co.uk',
    'user_name-1@example.travel',
    "o'brien@example.com",
    'UPPER@EXAMPLE.COM',
    'a@b.c',
  ])('accepts %s', (email) => {
    expect(isValidEmailAddress(email)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a two character string', 'a@'],
    ['no at sign', 'userexample.com'],
    ['a leading at sign', '@example.com'],
    ['two at signs', 'user@host@example.com'],
    ['a domain with no dot', 'user@example'],
    ['a domain that is only a dot', 'user@.'],
    ['an empty domain label', 'user@example..com'],
    ['a trailing dot', 'user@example.com.'],
    ['a leading dot in the domain', 'user@.example.com'],
    ['an internal space', 'user name@example.com'],
    ['a leading space', ' user@example.com'],
    ['a tab', 'user\t@example.com'],
    ['a newline', 'user@example.com\n'],
    ['a carriage return', 'user\r@example.com'],
    ['a null byte', 'user\u0000@example.com'],
    ['a delete character', 'user\u007f@example.com'],
    ['an empty local part', '@b.co'],
  ])('rejects %s', (_label, email) => {
    expect(isValidEmailAddress(email)).toBe(false);
  });

  it('accepts a local part of exactly 64 characters', () => {
    expect(isValidEmailAddress(`${'a'.repeat(64)}@example.com`)).toBe(true);
  });

  it('rejects a local part of 65 characters', () => {
    expect(isValidEmailAddress(`${'a'.repeat(65)}@example.com`)).toBe(false);
  });

  it('accepts a domain label of exactly 63 characters', () => {
    expect(isValidEmailAddress(`user@${'a'.repeat(63)}.com`)).toBe(true);
  });

  it('rejects a domain label of 64 characters', () => {
    expect(isValidEmailAddress(`user@${'a'.repeat(64)}.com`)).toBe(false);
  });

  it('accepts an address of exactly 254 characters', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const email = `${local}@${domain}`;

    expect(email).toHaveLength(254);
    expect(isValidEmailAddress(email)).toBe(true);
  });

  it('rejects an address of 255 characters', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    const email = `${local}@${domain}`;

    expect(email).toHaveLength(255);
    expect(isValidEmailAddress(email)).toBe(false);
  });

  it('rejects a three character address because the domain cannot hold a dot', () => {
    // The length floor is 3, so this documents that the domain rule, not the
    // length rule, is what rejects the shortest inputs.
    expect(isValidEmailAddress('a@b')).toBe(false);
    expect(isValidEmailAddress('ab')).toBe(false);
  });
});

describe('isDisposableEmailDomain', () => {
  it.each([
    'someone@mailinator.com',
    'someone@yopmail.com',
    'someone@guerrillamail.net',
    'someone@10minutemail.com',
  ])('refuses %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(true);
  });

  // Several of these providers hand out a fresh subdomain per visit, so an
  // exact-match lookup would let every one of them through.
  it('follows a disposable provider into its subdomains', () => {
    expect(isDisposableEmailDomain('someone@inbox.mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('someone@a.b.mailinator.com')).toBe(true);
  });

  it('is not fooled by a domain that merely ends with the same letters', () => {
    expect(isDisposableEmailDomain('someone@notmailinator.com')).toBe(false);
    expect(isDisposableEmailDomain('someone@mailinator.com.example.org')).toBe(false);
  });

  it.each([
    'someone@gmail.com',
    'someone@studio.co.uk',
    // Forwarding and masking services are what privacy-minded paying customers
    // actually use. Blocking them would cost real revenue.
    'someone@simplelogin.io',
    'someone@anonaddy.me',
    'someone@privaterelay.appleid.com',
  ])('accepts %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(false);
  });

  it('ignores case and surrounding whitespace in the domain', () => {
    expect(isDisposableEmailDomain('Someone@MailInator.COM')).toBe(true);
  });

  it('returns false for a string with no domain at all', () => {
    expect(isDisposableEmailDomain('someone')).toBe(false);
    expect(isDisposableEmailDomain('')).toBe(false);
  });
});
