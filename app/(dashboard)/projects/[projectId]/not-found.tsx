import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { FolderX } from 'lucide-react';

export default function ProjectNotFound() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <FolderX className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Project Not Found</h1>
        <p className="text-muted-foreground max-w-md">
          The project you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to
          it.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="default">
          <Link href="/dashboard">View all projects</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/projects/new">Create new project</Link>
        </Button>
      </div>
    </div>
  );
}
