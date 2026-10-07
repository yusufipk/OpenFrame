import type { TeamUploader } from '@/lib/uploader-stats';

export function TeamUploaders({ uploaders }: { uploaders: TeamUploader[] }) {
  return (
    <div>
      <span className="tabular-nums">{uploaders.length}</span>
      {uploaders.length > 0 && (
        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
          {uploaders.map((uploader) => (
            <li key={uploader.userId} title={uploader.email ?? undefined}>
              {uploader.name?.trim() || uploader.email || 'Unnamed member'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
