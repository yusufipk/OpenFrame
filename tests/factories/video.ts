import {
  VideoAssetKind,
  VideoAssetProvider,
  type UploadReservation,
  type Video,
  type VideoAsset,
  type VideoVersion,
} from '@prisma/client';
import { db } from '@/lib/db';
import { UPLOAD_RESERVATION_PURPOSES, type UploadReservationPurpose } from '@/lib/storage-quota';
import { nextSeq } from './seq';

export interface CreateVideoInput {
  projectId: string;
  title?: string;
  description?: string | null;
  position?: number;
}

export async function createVideo(input: CreateVideoInput): Promise<Video> {
  const seq = nextSeq();
  return db.video.create({
    data: {
      projectId: input.projectId,
      title: input.title ?? `Video ${seq}`,
      description: input.description ?? null,
      position: input.position ?? 0,
    },
  });
}

export interface CreateVersionInput {
  /** The parent Video row. Maps to VideoVersion.videoParentId. */
  videoParentId: string;
  versionNumber?: number;
  versionLabel?: string | null;
  /** 'youtube' | 'r2' | 'bunny' | ... Maps to VideoVersion.providerId. */
  providerId?: string;
  /** The id the provider knows the media by. Maps to VideoVersion.videoId. */
  providerVideoId?: string;
  originalUrl?: string;
  title?: string | null;
  thumbnailUrl?: string | null;
  duration?: number | null;
  sizeBytes?: bigint;
  isActive?: boolean;
  uploadedById?: string | null;
  createdAt?: Date;
}

export async function createVersion(input: CreateVersionInput): Promise<VideoVersion> {
  const seq = nextSeq();
  const providerVideoId = input.providerVideoId ?? `provider-video-${seq}`;
  return db.videoVersion.create({
    data: {
      videoParentId: input.videoParentId,
      versionNumber: input.versionNumber ?? 1,
      versionLabel: input.versionLabel ?? null,
      providerId: input.providerId ?? 'youtube',
      videoId: providerVideoId,
      originalUrl: input.originalUrl ?? `https://www.youtube.com/watch?v=${providerVideoId}`,
      title: input.title ?? `Version ${seq}`,
      thumbnailUrl: input.thumbnailUrl ?? null,
      duration: input.duration ?? 120,
      sizeBytes: input.sizeBytes ?? BigInt(0),
      isActive: input.isActive ?? true,
      uploadedById: input.uploadedById ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

export interface CreateVideoAssetInput {
  videoId: string;
  billedUserId: string;
  kind?: VideoAssetKind;
  provider?: VideoAssetProvider;
  displayName?: string;
  sourceUrl?: string;
  providerVideoId?: string | null;
  thumbnailUrl?: string | null;
  uploadedByUserId?: string | null;
  uploadedByGuestIdentityId?: string | null;
  uploadedByGuestName?: string | null;
  sizeBytes?: bigint;
}

export async function createVideoAsset(input: CreateVideoAssetInput): Promise<VideoAsset> {
  const seq = nextSeq();
  return db.videoAsset.create({
    data: {
      videoId: input.videoId,
      billedUserId: input.billedUserId,
      kind: input.kind ?? VideoAssetKind.IMAGE,
      provider: input.provider ?? VideoAssetProvider.R2_IMAGE,
      displayName: input.displayName ?? `asset-${seq}.png`,
      sourceUrl: input.sourceUrl ?? `/api/upload/image/asset-${seq}.png`,
      providerVideoId: input.providerVideoId ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      uploadedByUserId: input.uploadedByUserId ?? null,
      uploadedByGuestIdentityId: input.uploadedByGuestIdentityId ?? null,
      uploadedByGuestName: input.uploadedByGuestName ?? null,
      sizeBytes: input.sizeBytes ?? BigInt(0),
    },
  });
}

export interface CreateUploadReservationInput {
  billedUserId: string;
  sizeBytes: bigint;
  /** Milliseconds from now. Negative values produce an already-expired row. */
  expiresInMs?: number;
  /** Which flow the hold belongs to. Only that flow can consume it. */
  purpose?: UploadReservationPurpose;
}

export async function createUploadReservation(
  input: CreateUploadReservationInput
): Promise<UploadReservation> {
  return db.uploadReservation.create({
    data: {
      billedUserId: input.billedUserId,
      sizeBytes: input.sizeBytes,
      expiresAt: new Date(Date.now() + (input.expiresInMs ?? 30 * 60 * 1000)),
      purpose: input.purpose ?? UPLOAD_RESERVATION_PURPOSES.R2_VIDEO,
    },
  });
}
