'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Captions, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SUBTITLE_BACKGROUND_OPTIONS,
  SUBTITLE_SIZE_OPTIONS,
  type SubtitleAppearance,
} from '@/components/video-page/hooks/subtitle-appearance';
import type { SubtitleTrackOption } from '@/components/video-page/types';

const COMMON_LANGUAGES = [
  'tr',
  'en',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ar',
  'ja',
  'ko',
  'zh',
  'hi',
] as const;

const OTHER_LANGUAGE = '__other__';

/** A file named `cut-v3.tr.srt` already says which language it is. */
const LANGUAGE_FROM_FILENAME = /\.([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.(?:srt|vtt)$/i;

function describeLanguage(tag: string): string {
  try {
    const displayNames = new Intl.DisplayNames(undefined, { type: 'language' });
    return displayNames.of(tag) || tag.toUpperCase();
  } catch {
    return tag.toUpperCase();
  }
}

function guessLanguageFromFileName(fileName: string): string | null {
  const match = LANGUAGE_FROM_FILENAME.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

interface SubtitleControlsProps {
  /**
   * What the menu lists. For a Bunny or R2 version these are the tracks uploaded to this
   * cut; for a YouTube version they are the captions the video already carries, which is
   * why the shape is narrower than a stored subtitle.
   */
  subtitles: SubtitleTrackOption[];
  activeSubtitleLanguage: string | null;
  onSelectSubtitleLanguage: (language: string | null) => void;
  canManageSubtitles: boolean;
  onUploadSubtitle: (file: File, language: string, label: string) => Promise<string | null>;
  onDeleteSubtitle: (subtitleId: string) => Promise<string | null>;
  isUploadingSubtitle: boolean;
  appearance: SubtitleAppearance;
  onChangeAppearance: (next: Partial<SubtitleAppearance>) => void;
  /** False for YouTube, whose embed API offers a caption size but no background. */
  supportsBackground: boolean;
}

export const SubtitleControls = memo(function SubtitleControls({
  subtitles,
  activeSubtitleLanguage,
  onSelectSubtitleLanguage,
  canManageSubtitles,
  onUploadSubtitle,
  onDeleteSubtitle,
  isUploadingSubtitle,
  appearance,
  onChangeAppearance,
  supportsBackground,
}: SubtitleControlsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [languageChoice, setLanguageChoice] = useState<string>('tr');
  const [customLanguage, setCustomLanguage] = useState('');
  const [label, setLabel] = useState('');

  const activeSubtitle = useMemo(
    () => subtitles.find((subtitle) => subtitle.language === activeSubtitleLanguage) ?? null,
    [activeSubtitleLanguage, subtitles]
  );

  const resolvedLanguage = (
    languageChoice === OTHER_LANGUAGE ? customLanguage : languageChoice
  ).trim();

  const handleFileChosen = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Clearing the input lets the same file be picked again after a failed upload.
    event.target.value = '';
    if (!file) return;

    const guessed = guessLanguageFromFileName(file.name);
    const known = guessed && (COMMON_LANGUAGES as readonly string[]).includes(guessed);
    setLanguageChoice(known ? (guessed as string) : guessed ? OTHER_LANGUAGE : 'tr');
    setCustomLanguage(known ? '' : (guessed ?? ''));
    setLabel('');
    setPendingFile(file);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!pendingFile || !resolvedLanguage) return;
    const finalLabel = label.trim() || describeLanguage(resolvedLanguage);
    const error = await onUploadSubtitle(pendingFile, resolvedLanguage, finalLabel);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Subtitle added');
    setPendingFile(null);
  }, [label, onUploadSubtitle, pendingFile, resolvedLanguage]);

  const handleDelete = useCallback(
    async (subtitle: SubtitleTrackOption) => {
      const error = await onDeleteSubtitle(subtitle.id);
      if (error) {
        toast.error(error);
        return;
      }
      toast.success(`${subtitle.label} removed`);
    },
    [onDeleteSubtitle]
  );

  if (subtitles.length === 0 && !canManageSubtitles) return null;

  const replacesExisting = subtitles.some(
    (subtitle) => subtitle.language === resolvedLanguage.toLowerCase()
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={activeSubtitle ? 'default' : 'ghost'}
            size="sm"
            className="h-8 gap-1 text-xs"
            title="Subtitles (C)"
          >
            <Captions className="h-3.5 w-3.5" />
            {/* A phone's control row has no room for a language name. */}
            <span className="hidden sm:inline">{activeSubtitle ? activeSubtitle.label : 'CC'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuItem
            onClick={() => onSelectSubtitleLanguage(null)}
            className={cn(!activeSubtitleLanguage && 'font-bold text-primary')}
          >
            Off
          </DropdownMenuItem>
          {subtitles.map((subtitle) => (
            <DropdownMenuItem
              key={subtitle.id}
              onClick={() => onSelectSubtitleLanguage(subtitle.language)}
              className={cn(
                'flex items-center justify-between gap-2',
                subtitle.language === activeSubtitleLanguage && 'font-bold text-primary'
              )}
            >
              <span className="truncate">{subtitle.label}</span>
              {subtitle.canDelete && (
                <button
                  type="button"
                  aria-label={`Delete ${subtitle.label} subtitle`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleDelete(subtitle);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          ))}
          {subtitles.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  Size
                  <span className="flex-1 pl-4 text-right text-muted-foreground">
                    {SUBTITLE_SIZE_OPTIONS.find((option) => option.value === appearance.size)
                      ?.label ?? ''}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {SUBTITLE_SIZE_OPTIONS.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => onChangeAppearance({ size: option.value })}
                      className={cn(option.value === appearance.size && 'font-bold text-primary')}
                    >
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {supportsBackground && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    Background
                    <span className="flex-1 pl-4 text-right text-muted-foreground">
                      {SUBTITLE_BACKGROUND_OPTIONS.find(
                        (option) => option.value === appearance.background
                      )?.label ?? ''}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {SUBTITLE_BACKGROUND_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => onChangeAppearance({ background: option.value })}
                        className={cn(
                          option.value === appearance.background && 'font-bold text-primary'
                        )}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </>
          )}
          {canManageSubtitles && (
            <>
              {subtitles.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingSubtitle}
              >
                <Upload className="h-3.5 w-3.5 mr-2" />
                Add subtitle
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        className="hidden"
        onChange={handleFileChosen}
      />

      <Dialog
        open={!!pendingFile}
        onOpenChange={(open) => {
          if (!open && !isUploadingSubtitle) setPendingFile(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add subtitle</DialogTitle>
            <DialogDescription>
              {pendingFile?.name} is attached to this version only, because cue timings belong to
              one cut. SRT files are converted to WebVTT on upload.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subtitle-language">Language</Label>
              <Select value={languageChoice} onValueChange={setLanguageChoice}>
                <SelectTrigger id="subtitle-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_LANGUAGES.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {describeLanguage(tag)}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_LANGUAGE}>Other</SelectItem>
                </SelectContent>
              </Select>
              {languageChoice === OTHER_LANGUAGE && (
                <Input
                  value={customLanguage}
                  onChange={(event) => setCustomLanguage(event.target.value)}
                  placeholder="Language tag, e.g. en-US"
                  maxLength={20}
                />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="subtitle-label">Label</Label>
              <Input
                id="subtitle-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={resolvedLanguage ? describeLanguage(resolvedLanguage) : 'Türkçe'}
                maxLength={60}
              />
            </div>

            {replacesExisting && (
              <p className="text-xs text-muted-foreground">
                This version already has a track in that language. Uploading replaces it.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingFile(null)}
              disabled={isUploadingSubtitle}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleUpload()}
              disabled={isUploadingSubtitle || !resolvedLanguage}
            >
              {isUploadingSubtitle && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
