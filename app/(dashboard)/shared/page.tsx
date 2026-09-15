import Link from 'next/link';
import { requireAuthOrRedirect } from '@/lib/route-access';
import { visibleFolderWhere, visibleVideoWhere } from '@/lib/content-access';
import { db } from '@/lib/db';

export default async function SharedContentPage() {
  const session = await requireAuthOrRedirect();
  const userId = session.user.id;
  const [folders, videos] = await Promise.all([
    db.projectFolder.findMany({
      where: { members: { some: { userId } }, AND: visibleFolderWhere(userId) },
      select: { id: true, name: true, projectId: true },
      orderBy: { name: 'asc' },
    }),
    db.video.findMany({
      where: { members: { some: { userId } }, AND: visibleVideoWhere(userId) },
      select: { id: true, title: true, projectId: true },
      orderBy: { title: 'asc' },
    }),
  ]);
  return (
    <main className="p-8 space-y-6">
      <h1 className="text-2xl font-semibold">Shared with me</h1>
      <p className="text-muted-foreground">
        Folders and videos shared directly with your account. Folder access includes inherited
        contents, but not restricted descendants or sibling folders.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        {folders.map((f) => (
          <Link
            className="rounded-lg border p-5 hover:bg-muted"
            key={f.id}
            href={`/projects/${f.projectId}?folderId=${f.id}`}
          >
            {f.name}
            <span className="block text-sm text-muted-foreground">Folder</span>
          </Link>
        ))}
        {videos.map((v) => (
          <Link
            className="rounded-lg border p-5 hover:bg-muted"
            key={v.id}
            href={`/projects/${v.projectId}/videos/${v.id}`}
          >
            {v.title}
            <span className="block text-sm text-muted-foreground">Video</span>
          </Link>
        ))}
      </div>
      {!folders.length && !videos.length && <p>No directly shared content yet.</p>}
    </main>
  );
}
