import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import {
  buildRuntimePublicConfig,
  readRuntimePublicConfig,
  resolvePublicDirectDownloadAllowedHosts,
  RUNTIME_PUBLIC_CONFIG_ELEMENT_ID,
} from '@/lib/runtime-public-config';

/**
 * These run in jsdom because that is the only place the bug shows: on the server
 * the environment is readable at request time, in the browser it is whatever was
 * inlined when the bundle was built, which for the published Docker image is
 * nothing.
 */
function injectConfig(payload: string): void {
  const element = document.createElement('script');
  element.id = RUNTIME_PUBLIC_CONFIG_ELEMENT_ID;
  element.type = 'application/json';
  element.textContent = payload;
  document.body.appendChild(element);
}

beforeEach(() => {
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', undefined);
  vi.stubEnv('GOOGLE_CLIENT_ID', undefined);
  vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', undefined);
  vi.stubEnv('GOOGLE_PICKER_API_KEY', undefined);
  vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.getElementById(RUNTIME_PUBLIC_CONFIG_ELEMENT_ID)?.remove();
});

describe('buildRuntimePublicConfig', () => {
  it('prefers the server variable over the public one', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://server.b-cdn.net');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(buildRuntimePublicConfig().bunnyCdnUrl).toBe('https://server.b-cdn.net');
  });

  it('emits empty strings rather than undefined when nothing is configured', () => {
    expect(buildRuntimePublicConfig()).toEqual({
      bunnyCdnUrl: '',
      directDownloadAllowedHosts: '',
      googleDrive: null,
    });
  });

  it('hands the browser the Google Picker settings on a host that can import from Drive', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_PICKER_API_KEY', 'picker-key');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '1234');
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '1');

    expect(buildRuntimePublicConfig().googleDrive).toEqual({
      clientId: 'client.apps.googleusercontent.com',
      apiKey: 'picker-key',
      appId: '1234',
    });
  });

  // The Picker settings are useless without somewhere to put the video, and
  // showing the button would lead to a refusal from the import route.
  it('leaves the Picker settings out when the host has no upload backend', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_PICKER_API_KEY', 'picker-key');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '1234');
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');

    expect(buildRuntimePublicConfig().googleDrive).toBeNull();
  });
});

describe('readRuntimePublicConfig', () => {
  it('returns null when the page carries no config', () => {
    expect(readRuntimePublicConfig()).toBeNull();
  });

  it('returns null for a payload that is not valid JSON', () => {
    injectConfig('{ not json');

    expect(readRuntimePublicConfig()).toBeNull();
  });

  it('coerces missing or non-string fields to empty strings', () => {
    injectConfig(JSON.stringify({ bunnyCdnUrl: 42 }));

    expect(readRuntimePublicConfig()).toEqual({
      bunnyCdnUrl: '',
      directDownloadAllowedHosts: '',
      googleDrive: null,
    });
  });

  it('reads the Google Picker settings back', () => {
    injectConfig(
      JSON.stringify({ googleDrive: { clientId: 'client', apiKey: 'key', appId: '1234' } })
    );

    expect(readRuntimePublicConfig()?.googleDrive).toEqual({
      clientId: 'client',
      apiKey: 'key',
      appId: '1234',
    });
  });

  it('treats Google Picker settings with an empty key as none at all', () => {
    injectConfig(
      JSON.stringify({ googleDrive: { clientId: 'client', apiKey: '', appId: '1234' } })
    );

    expect(readRuntimePublicConfig()?.googleDrive).toBeNull();
  });
});

describe('resolvePublicBunnyCdnHostname in the browser', () => {
  it('uses the injected hostname when the build-time variable is empty', () => {
    // The published Docker image, where the operator configured BUNNY_CDN_URL at
    // runtime and the bundle was built without it.
    injectConfig(JSON.stringify({ bunnyCdnUrl: 'https://vz-runtime.b-cdn.net' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-runtime.b-cdn.net');
  });

  it('prefers the injected hostname over the one inlined at build time', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://vz-build.b-cdn.net');
    injectConfig(JSON.stringify({ bunnyCdnUrl: 'https://vz-runtime.b-cdn.net' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-runtime.b-cdn.net');
  });

  it('falls back to the build-time variable when the injected value is empty', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://vz-build.b-cdn.net');
    injectConfig(JSON.stringify({ bunnyCdnUrl: '' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-build.b-cdn.net');
  });

  it('returns null when neither source is configured', () => {
    injectConfig(JSON.stringify({ bunnyCdnUrl: '' }));

    expect(resolvePublicBunnyCdnHostname()).toBeNull();
  });
});

describe('resolvePublicDirectDownloadAllowedHosts', () => {
  it('splits, trims and lowercases the injected list', () => {
    injectConfig(
      JSON.stringify({ directDownloadAllowedHosts: ' Files.Example.com , cdn.example.com ,, ' })
    );

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual([
      'files.example.com',
      'cdn.example.com',
    ]);
  });

  it('falls back to the build-time variable when no config is injected', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'files.example.com');

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual(['files.example.com']);
  });

  it('keeps the build-time list when the injected one is empty', () => {
    // An empty injected value means nothing was configured on this deployment, so
    // it must not narrow a source build that already had a list.
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'files.example.com');
    injectConfig(JSON.stringify({ directDownloadAllowedHosts: '' }));

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual(['files.example.com']);
  });

  it('returns an empty list when neither source is configured', () => {
    injectConfig(JSON.stringify({ directDownloadAllowedHosts: '' }));

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual([]);
  });
});
