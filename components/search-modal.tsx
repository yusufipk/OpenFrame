'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Input } from '@/components/ui/input';
import { Search, FolderOpen, Building2, Video, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProjectResult {
  id: string;
  name: string;
  description: string | null;
  workspace: { id: string; name: string };
}

interface WorkspaceResult {
  id: string;
  name: string;
  description: string | null;
}

interface VideoResult {
  id: string;
  title: string;
  projectId: string;
  project: { id: string; name: string };
}

interface SearchResults {
  projects: ProjectResult[];
  workspaces: WorkspaceResult[];
  videos: VideoResult[];
}

type ResultItem =
  | { kind: 'project'; data: ProjectResult }
  | { kind: 'workspace'; data: WorkspaceResult }
  | { kind: 'video'; data: VideoResult };

interface SearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function scoreMatch(name: string, term: string): number {
  const n = name.toLowerCase();
  const t = term.toLowerCase();
  if (n === t) return 3;
  if (n.startsWith(t)) return 2;
  return 1;
}

function buildFlatList(results: SearchResults, term: string): ResultItem[] {
  const projects: ResultItem[] = results.projects
    .map((p) => ({ kind: 'project' as const, data: p, score: scoreMatch(p.name, term) }))
    .sort((a, b) => b.score - a.score)
    .map(({ kind, data }) => ({ kind, data }));

  const workspaces: ResultItem[] = results.workspaces
    .map((w) => ({ kind: 'workspace' as const, data: w, score: scoreMatch(w.name, term) }))
    .sort((a, b) => b.score - a.score)
    .map(({ kind, data }) => ({ kind, data }));

  const videos: ResultItem[] = results.videos
    .map((v) => ({ kind: 'video' as const, data: v, score: scoreMatch(v.title, term) }))
    .sort((a, b) => b.score - a.score)
    .map(({ kind, data }) => ({ kind, data }));

  return [...projects, ...workspaces, ...videos];
}

function getItemHref(item: ResultItem): string {
  if (item.kind === 'project') return `/dashboard?project=${item.data.id}`;
  if (item.kind === 'workspace') return `/workspaces/${item.data.id}`;
  return `/projects/${item.data.projectId}/videos/${item.data.id}`;
}

function getItemLabel(item: ResultItem): string {
  if (item.kind === 'project') return item.data.name;
  if (item.kind === 'workspace') return item.data.name;
  return item.data.title;
}

function getItemSub(item: ResultItem): string | null {
  if (item.kind === 'project') return item.data.workspace.name;
  if (item.kind === 'workspace') return item.data.description ?? null;
  return item.data.project.name;
}

const CATEGORY_LABELS: Record<ResultItem['kind'], string> = {
  project: 'Projects',
  workspace: 'Workspaces',
  video: 'Videos',
};

const CategoryIcon: Record<ResultItem['kind'], React.ComponentType<{ className?: string }>> = {
  project: FolderOpen,
  workspace: Building2,
  video: Video,
};

export function SearchModal({ open, onOpenChange }: SearchModalProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset when modal opens/closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(null);
      setActiveIdx(0);
    } else {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const doSearch = useCallback(async (term: string) => {
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }

    // Cancel previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Search failed');
      const json = await res.json();
      setResults(json.data);
      setActiveIdx(0);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setResults(null);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (val.trim().length < 2) {
        abortRef.current?.abort();
        setResults(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      debounceRef.current = setTimeout(() => doSearch(val.trim()), 300);
    },
    [doSearch]
  );

  const flatList = useMemo(
    () => (results ? buildFlatList(results, query.trim()) : []),
    [results, query]
  );

  const handleSelect = useCallback(
    (item: ResultItem) => {
      onOpenChange(false);
      router.push(getItemHref(item));
    },
    [onOpenChange, router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatList.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, flatList.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatList[activeIdx];
        if (item) handleSelect(item);
      }
    },
    [flatList, activeIdx, handleSelect]
  );

  const isEmpty = !loading && results !== null && flatList.length === 0;
  const showInitial = !loading && results === null && query.length < 2;

  // Group flat list by category for section headers
  const sections: { kind: ResultItem['kind']; items: ResultItem[]; startIdx: number }[] = [];
  let cursor = 0;
  for (const kind of ['project', 'workspace', 'video'] as const) {
    const items = flatList.filter((i) => i.kind === kind);
    if (items.length > 0) {
      sections.push({ kind, items, startIdx: cursor });
      cursor += items.length;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl p-0 gap-0 overflow-hidden rounded-xl"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <VisuallyHidden>
          <DialogTitle>Search</DialogTitle>
        </VisuallyHidden>
        {/* Single flex-col wrapper keeps the grid from producing a stray gap row */}
        <div className="flex flex-col">

        {/* Search input */}
        <div className="flex items-center border-b px-4">
          <Search className="h-5 w-5 shrink-0 text-muted-foreground mr-3" />
          <Input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            placeholder="Search projects, workspaces, videos…"
            className="border-0 bg-transparent dark:bg-transparent shadow-none focus-visible:ring-0 h-14 text-base px-0"
          />
          {loading && <Loader2 className="h-4 w-4 shrink-0 text-muted-foreground animate-spin ml-3" />}
        </div>

        {/* Results */}
        <div className="h-[520px] overflow-y-auto">
          {showInitial && (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">
              Type at least 2 characters to search.
            </p>
          )}

          {isEmpty && (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}

          {sections.map(({ kind, items, startIdx }) => {
            const Icon = CategoryIcon[kind];
            return (
              <div key={kind}>
                <div className="px-3 pt-3 pb-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {CATEGORY_LABELS[kind]}
                  </span>
                </div>
                {items.map((item, localIdx) => {
                  const globalIdx = startIdx + localIdx;
                  const label = getItemLabel(item);
                  const sub = getItemSub(item);
                  const isActive = globalIdx === activeIdx;

                  return (
                    <button
                      key={`${kind}-${item.kind === 'project' ? item.data.id : item.kind === 'workspace' ? item.data.id : item.data.id}`}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                      )}
                      onMouseEnter={() => setActiveIdx(globalIdx)}
                      onClick={() => handleSelect(item)}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-accent-foreground/70' : 'text-muted-foreground')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{label}</p>
                        {sub && (
                          <p className={cn('text-xs truncate', isActive ? 'text-accent-foreground/60' : 'text-muted-foreground')}>{sub}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {sections.length > 0 && (
            <div className="h-2" />
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t px-4 py-2.5 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-muted px-1 font-mono text-[10px]">↑</kbd>
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-muted px-1 font-mono text-[10px]">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-muted px-1 font-mono text-[10px]">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-muted px-1 font-mono text-[10px]">Esc</kbd>
            close
          </span>
        </div>

        </div>{/* end flex-col wrapper */}
      </DialogContent>
    </Dialog>
  );
}
