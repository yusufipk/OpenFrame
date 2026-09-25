import { describe, it, expect } from 'vitest';
import {
  classifyChannel,
  extractReferrerHost,
  normalizeHost,
  sanitizeLandingPath,
  sanitizeTag,
} from '@/lib/analytics/channel';

// Every expected value below is written by hand. Deriving them from the lookup
// tables in the module would mean deleting an entry from a table also deletes
// its own test case.

describe('sanitizeTag', () => {
  it('lowercases and trims', () => {
    expect(sanitizeTag('  GitHub  ')).toBe('github');
  });

  it('rejects a tag carrying markup or control characters', () => {
    expect(sanitizeTag('<script>')).toBeNull();
    expect(sanitizeTag('news\nletter')).toBeNull();
  });

  it('caps the length at 64 characters', () => {
    expect(sanitizeTag('a'.repeat(200))).toHaveLength(64);
  });

  it('treats an empty or non-string value as absent', () => {
    expect(sanitizeTag('   ')).toBeNull();
    expect(sanitizeTag(null)).toBeNull();
    expect(sanitizeTag(undefined)).toBeNull();
  });
});

describe('normalizeHost', () => {
  it('drops the www prefix and the port', () => {
    expect(normalizeHost('WWW.GitHub.com:443')).toBe('github.com');
  });

  it('rejects a value that is not a host', () => {
    expect(normalizeHost('not a host')).toBeNull();
    expect(normalizeHost('https://github.com')).toBeNull();
  });
});

describe('extractReferrerHost', () => {
  it('returns the host of a full referrer URL', () => {
    expect(extractReferrerHost('https://news.ycombinator.com/item?id=1')).toBe(
      'news.ycombinator.com'
    );
  });

  it('drops the path and query, so a share token cannot be stored', () => {
    expect(extractReferrerHost('https://example.com/share/secret-token?email=a@b.com')).toBe(
      'example.com'
    );
  });

  it('ignores our own host, because that is a click inside the site', () => {
    expect(extractReferrerHost('https://open-frame.net/pricing', 'open-frame.net')).toBeNull();
    expect(extractReferrerHost('https://www.open-frame.net/pricing', 'open-frame.net')).toBeNull();
  });

  it('returns null for a missing or unparseable referrer', () => {
    expect(extractReferrerHost(null)).toBeNull();
    expect(extractReferrerHost('android-app://com.example')).toBeNull();
  });
});

describe('sanitizeLandingPath', () => {
  it('keeps the path and drops the query string', () => {
    expect(sanitizeLandingPath('/vs/frameio')).toBe('/vs/frameio');
  });

  it('redacts raw and encoded short share tokens from landing paths', () => {
    expect(sanitizeLandingPath('/s/abcdefghijklmnop')).toBe('/s');
    expect(sanitizeLandingPath('/s%2Fabcdefghijklmnop')).toBe('/s');
    expect(sanitizeLandingPath('/%73/abcdefghijklmnop')).toBe('/s');
    expect(sanitizeLandingPath('/s/abcdefghijklmnop?source=mail')).toBe('/s');
    expect(sanitizeLandingPath('/settings')).toBe('/settings');
  });

  it('falls back to / for anything that is not a path', () => {
    expect(sanitizeLandingPath('https://open-frame.net/x')).toBe('/');
    expect(sanitizeLandingPath(null)).toBe('/');
  });

  it('keeps what a real route can carry', () => {
    expect(sanitizeLandingPath('/vs/frame.io')).toBe('/vs/frame.io');
    expect(sanitizeLandingPath('/watch/cm4x-01_a')).toBe('/watch/cm4x-01_a');
    expect(sanitizeLandingPath('/blog/%C3%BCr%C3%BCn')).toBe('/blog/%C3%BCr%C3%BCn');
  });

  it('drops a path that could only have come from a hand-written cookie', () => {
    // The proxy feeds this a real pathname. The cookie reader feeds it whatever
    // the cookie said, and that value ends up in a database column.
    expect(sanitizeLandingPath('/<script>alert(1)</script>')).toBe('/');
    expect(sanitizeLandingPath('/ok\nX-Injected: 1')).toBe('/');
    expect(sanitizeLandingPath('/a b')).toBe('/');
  });
});

describe('classifyChannel', () => {
  it('is DIRECT with no tags and no referrer', () => {
    expect(classifyChannel({})).toBe('DIRECT');
  });

  it('reads the referring host when there are no tags', () => {
    expect(classifyChannel({ referrerHost: 'github.com' })).toBe('GITHUB');
    expect(classifyChannel({ referrerHost: 'gist.github.com' })).toBe('GITHUB');
    expect(classifyChannel({ referrerHost: 'youtu.be' })).toBe('YOUTUBE');
    expect(classifyChannel({ referrerHost: 'www.producthunt.com' })).toBe('REVIEW_LINK');
    expect(classifyChannel({ referrerHost: 'news.ycombinator.com' })).toBe('COMMUNITY');
  });

  it('treats every Google country domain as search', () => {
    expect(classifyChannel({ referrerHost: 'google.com' })).toBe('GOOGLE');
    expect(classifyChannel({ referrerHost: 'google.com.tr' })).toBe('GOOGLE');
    expect(classifyChannel({ referrerHost: 'news.google.co.uk' })).toBe('GOOGLE');
  });

  it('does not mistake a lookalike domain for the real one', () => {
    expect(classifyChannel({ referrerHost: 'notgithub.com' })).toBe('REFERRAL');
    expect(classifyChannel({ referrerHost: 'google.com.evil.example' })).toBe('REFERRAL');
  });

  it('counts an unrecognised site that links to us as a referral', () => {
    expect(classifyChannel({ referrerHost: 'someblog.example' })).toBe('REFERRAL');
  });

  it('prefers an explicit utm_source over the referring host', () => {
    expect(classifyChannel({ utmSource: 'youtube', referrerHost: 'google.com' })).toBe('YOUTUBE');
  });

  it('reads a utm_source that was written as a domain', () => {
    expect(classifyChannel({ utmSource: 'github.com' })).toBe('GITHUB');
  });

  it('files a tagged campaign we do not recognise as OTHER, not DIRECT', () => {
    expect(classifyChannel({ utmSource: 'conference-flyer' })).toBe('OTHER');
  });

  it('lets the medium that names the motion win over the source that names the place', () => {
    expect(classifyChannel({ utmSource: 'linkedin', utmMedium: 'outbound' })).toBe('OUTBOUND');
    expect(classifyChannel({ utmSource: 'github', utmMedium: 'email' })).toBe('OUTBOUND');
    expect(classifyChannel({ utmSource: 'someone', utmMedium: 'referral' })).toBe('REFERRAL');
  });

  it('ignores a source that fails sanitizing and falls back to the referrer', () => {
    expect(classifyChannel({ utmSource: '<script>', referrerHost: 'youtube.com' })).toBe('YOUTUBE');
  });
});
