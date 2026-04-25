import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Film } from 'lucide-react';

export default function VideoNotFound() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Film className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Video Not Found</h1>
        <p className="text-muted-foreground max-w-md">
          The video you&apos;re looking for doesn&apos;t exist or has been deleted.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="outline">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
