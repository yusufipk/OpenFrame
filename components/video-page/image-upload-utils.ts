'use client';

import { detectImageMime } from '@/lib/image-upload-validation';

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function validateImageFile(file: File): Promise<string | null> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return 'Image must be less than 10MB';
  }

  const header = await file.slice(0, 12).arrayBuffer();
  const detected = detectImageMime(new Uint8Array(header));
  if (!detected) {
    return 'Unsupported image format. Allowed: JPEG, PNG, GIF, WEBP';
  }

  return null;
}

export function extractPastedImageFile(data: DataTransfer | null | undefined): File | null {
  const items = data?.items;
  if (!items) return null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  return null;
}
