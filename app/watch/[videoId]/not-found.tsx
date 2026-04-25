import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Film, XCircle } from 'lucide-react';

export default function WatchNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="relative">
          <Film className="h-12 w-12 text-muted-foreground" />
          <XCircle className="absolute -bottom-1 -right-1 h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold">Video Not Found</h1>
        <p className="text-muted-foreground max-w-md">
          The video you&apos;re looking for doesn&apos;t exist, has been removed, or the link may be
          expired.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="default">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
