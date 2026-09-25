import { describe, expect, it } from 'vitest';
import {
  isImageFile,
  isUploadableMediaFile,
  uploadProjectImage,
} from '@/lib/client/project-image-upload';

describe('isImageFile', () => {
  it('accepts the three supported image formats when type matches or is unavailable', () => {
    expect(isImageFile({ name: 'draft.PNG', type: 'image/png' })).toBe(true);
    expect(isImageFile({ name: 'photo.jpeg', type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ name: 'photo.jpg', type: 'image/pjpeg' })).toBe(true);
    expect(isImageFile({ name: 'frame.webp', type: '' })).toBe(true);
  });

  it('rejects an unsupported extension or a mismatched reported type', () => {
    expect(isImageFile({ name: 'animation.gif', type: 'image/gif' })).toBe(false);
    expect(isImageFile({ name: 'photo.png', type: 'image/jpeg' })).toBe(false);
    expect(isImageFile({ name: 'movie.mp4', type: 'video/mp4' })).toBe(false);
  });
});

describe('isUploadableMediaFile', () => {
  it('routes supported images and videos while excluding unsupported files', () => {
    expect(isUploadableMediaFile({ name: 'still.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isUploadableMediaFile({ name: 'clip.mov', type: 'video/quicktime' })).toBe(true);
    expect(isUploadableMediaFile({ name: 'camera-export', type: 'video/mp4' })).toBe(true);
    expect(isUploadableMediaFile({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false);
  });
});

describe('uploadProjectImage', () => {
  it('rejects an already cancelled upload before starting a network request', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = { name: 'still.png', type: 'image/png', size: 128 } as File;
    await expect(
      uploadProjectImage('project', file, { signal: controller.signal })
    ).rejects.toThrow('Upload cancelled');
  });
  it('rejects an oversized image before starting a network request', async () => {
    const file = { name: 'large.webp', type: 'image/webp', size: 20 * 1024 * 1024 + 1 } as File;
    await expect(uploadProjectImage('project', file)).rejects.toThrow('20 MiB');
  });
});
