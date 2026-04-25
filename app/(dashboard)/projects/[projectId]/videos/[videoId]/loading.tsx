import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

function CommentSkeleton() {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-5 w-14 rounded" />
      </div>
      <Skeleton className="h-4 w-full mb-1" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export default function VideoPlayerLoading() {
  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col bg-background overflow-hidden">
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-12" />
              <Separator orientation="vertical" className="h-5" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-32 rounded-md" />
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
          </div>

          <div className="flex-1 bg-black min-h-0" />

          <div className="shrink-0 px-4 py-2 bg-background border-t">
            <div className="flex items-center gap-1 mb-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-4 w-24 ml-1" />
              <div className="ml-auto">
                <Skeleton className="h-8 w-12 rounded-md" />
              </div>
            </div>
            <Skeleton className="h-8 w-full rounded" />
          </div>
        </div>

        <div className="w-80 shrink-0 border-l bg-card flex flex-col overflow-hidden">
          <div className="shrink-0 flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <CommentSkeleton key={i} />
            ))}
          </div>

          <div className="shrink-0 border-t p-4">
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex items-center justify-between mt-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
