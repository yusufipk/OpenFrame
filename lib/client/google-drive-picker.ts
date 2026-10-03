'use client';

/**
 * Opens the Google Picker and returns the files the user chose, together with the
 * short-lived `drive.file` access token the server needs to read them.
 *
 * The token comes from Google Identity Services' token client, never from the
 * sign-in flow, so signing in with Google does not ask for Drive and someone who
 * signed in with a password can still import. It is kept in memory for its own
 * lifetime so a second import in the same session does not show the consent popup
 * again, and is never written anywhere.
 */

import { useSyncExternalStore } from 'react';
import { readRuntimePublicConfig } from '@/lib/runtime-public-config';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';

// A cached token is reused only while this much of its life is left. A copy to
// self-hosted storage can wait in the server's queue before it uses the token,
// so it should start out with most of its hour. Asking again is silent once
// the user has consented.
const TOKEN_REUSE_MIN_REMAINING_MS = 45 * 60 * 1000;

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string };

type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };

type PickerDoc = { id: string; name?: string; mimeType?: string };
type PickerCallbackData = { action: string; docs?: PickerDoc[] };

type DocsView = {
  setIncludeFolders: (value: boolean) => DocsView;
  setSelectFolderEnabled: (value: boolean) => DocsView;
  setEnableDrives: (value: boolean) => DocsView;
  setMimeTypes: (value: string) => DocsView;
  setParent: (value: string) => DocsView;
  setOwnedByMe: (value: boolean) => DocsView;
  setLabel: (value: string) => DocsView;
};

type PickerBuilder = {
  addView: (view: DocsView) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  setCallback: (callback: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

type GoogleNamespace = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => TokenClient;
      hasGrantedAllScopes: (response: TokenResponse, ...scopes: string[]) => boolean;
    };
  };
  picker: {
    DocsView: new (viewId?: string) => DocsView;
    PickerBuilder: new () => PickerBuilder;
    ViewId: { DOCS: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
    Action: { PICKED: string; CANCEL: string };
  };
};

type GapiNamespace = {
  load: (library: string, options: { callback: () => void; onerror: () => void }) => void;
};

declare global {
  interface Window {
    google?: GoogleNamespace;
    gapi?: GapiNamespace;
  }
}

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/**
 * What the picker lists for a video import. The Picker takes no `video/*`
 * wildcard, so the types are spelled out; the server still decides what it
 * accepts, and refuses a format the storage backend cannot play.
 */
export const DRIVE_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/ogg',
  'video/x-m4v',
  'video/mpeg',
  'video/3gpp',
  'video/mp2t',
  'video/x-ms-wmv',
  'video/x-flv',
] as const;

export type PickedDriveFile = { id: string; name: string };
export type DrivePickResult = { accessToken: string; files: PickedDriveFile[] };

export function getGoogleDrivePickerConfig() {
  return readRuntimePublicConfig()?.googleDrive ?? null;
}

const noSubscription = () => () => undefined;

/**
 * Whether this host offers Drive import, safe to call during render. The config
 * is injected into the page by the server and only readable in the browser, so
 * the server snapshot is false and the button appears after hydration.
 */
export function useGoogleDriveAvailable(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => getGoogleDrivePickerConfig() !== null,
    () => false
  );
}

const scriptLoads = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoads.delete(src);
      script.remove();
      reject(new Error('Could not load Google Drive. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  scriptLoads.set(src, promise);
  return promise;
}

let pickerLoad: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  pickerLoad ??= loadScript(GAPI_SCRIPT_URL).then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!window.gapi) {
          reject(new Error('Could not load Google Drive.'));
          return;
        }
        window.gapi.load('picker', {
          callback: () => resolve(),
          onerror: () => reject(new Error('Could not load the Google Drive picker.')),
        });
      })
  );
  pickerLoad.catch(() => {
    pickerLoad = null;
  });
  return pickerLoad;
}

/** Drops the cached token, e.g. after the server refused it, so the next pick asks Google again. */
export function forgetDriveAccessToken(): void {
  cachedToken = null;
}

/**
 * Loads both Google scripts ahead of the click. The consent popup has to open in
 * the same task as the click or the browser blocks it, so the token client must
 * already be there by then.
 */
export function preloadGoogleDrive(): void {
  if (!getGoogleDrivePickerConfig()) return;
  void loadScript(GIS_SCRIPT_URL).catch(() => undefined);
  void loadPicker().catch(() => undefined);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(clientId: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_REUSE_MIN_REMAINING_MS > Date.now()) {
    return cachedToken.value;
  }

  await loadScript(GIS_SCRIPT_URL);
  const google = window.google;
  if (!google?.accounts?.oauth2) throw new Error('Could not load Google sign-in.');

  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        // With granular consent the user can untick Drive and still hand back a
        // token, which the server would then refuse on every attempt.
        if (
          response.error ||
          !response.access_token ||
          !google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_FILE_SCOPE)
        ) {
          reject(new Error('Google Drive access was not granted.'));
          return;
        }
        const expiresIn = Number(response.expires_in) || 3600;
        cachedToken = { value: response.access_token, expiresAt: Date.now() + expiresIn * 1000 };
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(
          new Error(
            error?.type === 'popup_closed'
              ? 'The Google window was closed before access was granted.'
              : 'Google Drive access was not granted.'
          )
        );
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/**
 * Resolves with the picked files, or null when the user closed the picker.
 * `multiple` is off where exactly one file is taken, such as a new version.
 */
export async function pickDriveFiles(options: {
  multiple: boolean;
  mimeTypes: readonly string[];
  title: string;
}): Promise<DrivePickResult | null> {
  const config = getGoogleDrivePickerConfig();
  if (!config) throw new Error('Google Drive import is not available on this server.');

  // The token first: its popup has to open straight from the click, before any
  // slower script load, or the browser treats it as unrequested and blocks it.
  const [accessToken] = await Promise.all([getAccessToken(config.clientId), loadPicker()]);
  const google = window.google;
  if (!google?.picker) throw new Error('Could not load the Google Drive picker.');

  // Folders have to be in the type filter too, or a filtered view hides them
  // and the user can only search, not browse their own folder tree.
  const listed = [...options.mimeTypes, FOLDER_MIME_TYPE].join(',');
  const docsView = () =>
    new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(listed)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

  return new Promise<DrivePickResult | null>((resolve) => {
    // Starting at the root is what makes My Drive a folder tree rather than a
    // flat list of every matching file.
    const myDrive = docsView().setParent('root').setLabel('My Drive');
    // setOwnedByMe is ignored on a view that includes folders, so this one is a
    // flat list of files others shared, which is what Drive's own tab shows too.
    const sharedWithMe = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(options.mimeTypes.join(','))
      .setOwnedByMe(false)
      .setLabel('Shared with me');
    const sharedDrives = docsView().setEnableDrives(true).setLabel('Shared drives');

    let builder = new google.picker.PickerBuilder()
      .addView(myDrive)
      .addView(sharedWithMe)
      .addView(sharedDrives)
      .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(window.location.origin)
      .setTitle(options.title)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const files = (data.docs ?? [])
            .filter((doc) => typeof doc.id === 'string' && doc.mimeType !== FOLDER_MIME_TYPE)
            .map((doc) => ({ id: doc.id, name: doc.name || 'Untitled file' }));
          resolve({ accessToken, files });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      });
    if (options.multiple) {
      builder = builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
    }
    builder.build().setVisible(true);
  });
}
