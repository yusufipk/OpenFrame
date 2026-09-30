'use client';

import { useRef, useState } from 'react';
import { Loader2, Palette, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProjectBrandBanner, ProjectBrandLogo } from '@/components/project-branding';
import {
  BRAND_ASSET_MAX_BYTES,
  brandForeground,
  brandStyle,
  contrastRatio,
  normalizeBrandColor,
  type BrandAssetKind,
  type ProjectBranding,
} from '@/lib/project-branding';

const EMPTY_BRANDING: ProjectBranding = { color: null, bannerUrl: null, logoUrl: null };
const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';
const COLOR_PLACEHOLDER = '#e4572e';

interface ProjectBrandingCardProps {
  projectId: string;
  projectName: string;
  initialBranding: ProjectBranding | null;
}

export function ProjectBrandingCard({
  projectId,
  projectName,
  initialBranding,
}: ProjectBrandingCardProps) {
  const [branding, setBranding] = useState<ProjectBranding>(initialBranding ?? EMPTY_BRANDING);
  const [colorDraft, setColorDraft] = useState(initialBranding?.color ?? '');
  const [isSavingColor, setIsSavingColor] = useState(false);
  const [busyAsset, setBusyAsset] = useState<BrandAssetKind | null>(null);
  const [error, setError] = useState('');
  const bannerInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const draftColor = normalizeBrandColor(colorDraft);
  const colorChanged = (draftColor ?? null) !== branding.color;
  const previewColor = draftColor ?? branding.color;

  const saveColor = async (color: string | null) => {
    setIsSavingColor(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandColor: color }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error || 'Failed to save the brand color');
        return;
      }
      setBranding((current) => ({ ...current, color }));
      setColorDraft(color ?? '');
    } catch {
      setError('Failed to save the brand color');
    } finally {
      setIsSavingColor(false);
    }
  };

  const uploadAsset = async (kind: BrandAssetKind, file: File) => {
    if (file.size > BRAND_ASSET_MAX_BYTES) {
      setError('Images can be up to 5MB.');
      return;
    }
    setBusyAsset(kind);
    setError('');
    try {
      const form = new FormData();
      form.set('kind', kind);
      form.set('image', file);
      const response = await fetch(`/api/projects/${projectId}/branding`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error || 'Failed to upload the image');
        return;
      }
      setBranding(payload.data.branding ?? EMPTY_BRANDING);
    } catch {
      setError('Failed to upload the image');
    } finally {
      setBusyAsset(null);
    }
  };

  const removeAsset = async (kind: BrandAssetKind) => {
    setBusyAsset(kind);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/branding?kind=${kind}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error || 'Failed to remove the image');
        return;
      }
      setBranding(payload.data.branding ?? EMPTY_BRANDING);
    } catch {
      setError('Failed to remove the image');
    } finally {
      setBusyAsset(null);
    }
  };

  const onFileChosen = (kind: BrandAssetKind) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void uploadAsset(kind, file);
  };

  const assetControls = (kind: BrandAssetKind, hasAsset: boolean) => (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busyAsset !== null}
        onClick={() => (kind === 'banner' ? bannerInput : logoInput).current?.click()}
      >
        {busyAsset === kind ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        {hasAsset ? 'Replace' : 'Upload'}
      </Button>
      {hasAsset ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busyAsset !== null}
          onClick={() => void removeAsset(kind)}
        >
          <X className="h-4 w-4 mr-2" />
          Remove
        </Button>
      ) : null}
    </div>
  );

  let contrastNote: string | null = null;
  if (previewColor) {
    const foreground = brandForeground(previewColor);
    const used = contrastRatio(previewColor, foreground).toFixed(1);
    const other = contrastRatio(
      previewColor,
      foreground === '#000000' ? '#ffffff' : '#000000'
    ).toFixed(1);
    contrastNote = `Button text will be ${foreground === '#000000' ? 'black' : 'white'} (${used}:1). The other choice would be ${other}:1.`;
  }

  return (
    <Card id="client-branding" className="border-border/50 shadow-lg">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Palette className="h-5 w-5" />
          Client branding
        </CardTitle>
        <CardDescription>
          Show your client&apos;s color, banner and logo to everyone who opens this project. Text,
          backgrounds and dark mode stay OpenFrame&apos;s own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="brand-color">Brand color</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              aria-label="Pick brand color"
              value={draftColor ?? branding.color ?? COLOR_PLACEHOLDER}
              onChange={(event) => setColorDraft(event.target.value)}
              className="h-9 w-12 cursor-pointer border bg-transparent p-1"
            />
            <Input
              id="brand-color"
              value={colorDraft}
              onChange={(event) => setColorDraft(event.target.value)}
              placeholder={COLOR_PLACEHOLDER}
              className="w-32 font-mono"
              maxLength={7}
            />
            <Button
              type="button"
              size="sm"
              disabled={isSavingColor || !colorChanged || (colorDraft.trim() !== '' && !draftColor)}
              onClick={() => void saveColor(draftColor)}
            >
              {isSavingColor ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Save color
            </Button>
            {branding.color ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSavingColor}
                onClick={() => void saveColor(null)}
              >
                Reset to default
              </Button>
            ) : null}
          </div>
          {colorDraft.trim() !== '' && !draftColor ? (
            <p className="text-sm text-destructive">Use a hex color like #1a2b3c.</p>
          ) : contrastNote ? (
            <p className="text-sm text-muted-foreground">{contrastNote}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Banner</Label>
          <p className="text-sm text-muted-foreground">
            A wide image, about 4:1 (for example 1600 x 400). It is shown full width above the
            project name and cropped to 4:1 from the center, so keep text away from the edges.
          </p>
          {branding.bannerUrl ? <ProjectBrandBanner src={branding.bannerUrl} /> : null}
          {assetControls('banner', !!branding.bannerUrl)}
          <input
            ref={bannerInput}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            className="hidden"
            onChange={onFileChosen('banner')}
          />
        </div>

        <div className="space-y-2">
          <Label>
            Logo <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <p className="text-sm text-muted-foreground">
            A square PNG, JPG or WebP, ideally with a transparent background. Shown next to the
            project name and in the video page&apos;s top bar.
          </p>
          <div className="flex items-center gap-3">
            {branding.logoUrl ? <ProjectBrandLogo src={branding.logoUrl} /> : null}
            {assetControls('logo', !!branding.logoUrl)}
          </div>
          <input
            ref={logoInput}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            className="hidden"
            onChange={onFileChosen('logo')}
          />
        </div>

        {previewColor || branding.bannerUrl || branding.logoUrl ? (
          <div className="space-y-2">
            <Label>Preview</Label>
            <div className="border p-4 space-y-3" style={brandStyle(previewColor)}>
              {branding.bannerUrl ? <ProjectBrandBanner src={branding.bannerUrl} /> : null}
              <div className="flex items-center gap-2">
                {branding.logoUrl ? <ProjectBrandLogo src={branding.logoUrl} /> : null}
                <span className="text-lg font-semibold truncate">{projectName}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" tabIndex={-1}>
                  Share
                </Button>
                <span className="text-sm text-primary underline underline-offset-4">
                  Hero cut 30s
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
