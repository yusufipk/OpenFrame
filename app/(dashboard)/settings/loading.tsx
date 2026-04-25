import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardHeader, CardContent } from '@/components/ui/card';

function SettingsCardSkeleton({ rows }: { rows: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64 mt-1" />
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SettingsLoading() {
  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-80 mt-2" />
        </div>

        <SettingsCardSkeleton rows={5} />

        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72 mt-1" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          </CardContent>
        </Card>

        <SettingsCardSkeleton rows={3} />

        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-60 mt-1" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-10 w-full rounded-md" />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Skeleton className="h-10 w-32 rounded-md" />
        </div>
      </div>
    </div>
  );
}
