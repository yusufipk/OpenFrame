import { visibleVideoWhere } from '@/lib/content-access';
import { db } from '@/lib/db';

export interface ApprovalCandidate {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

function addCandidate(
  map: Map<string, ApprovalCandidate>,
  user: ApprovalCandidate | null | undefined
) {
  if (!user) return;
  map.set(user.id, user);
}

export async function getApprovalCandidatesForProject(
  projectId: string,
  videoId?: string
): Promise<ApprovalCandidate[] | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      owner: { select: { id: true, name: true, email: true, image: true } },
      members: {
        select: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
      workspace: {
        select: {
          owner: { select: { id: true, name: true, email: true, image: true } },
          members: {
            select: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
          },
        },
      },
    },
  });

  if (!project) return null;

  const map = new Map<string, ApprovalCandidate>();
  addCandidate(map, project.owner);
  addCandidate(map, project.workspace.owner);

  for (const member of project.members) {
    addCandidate(map, member.user);
  }
  for (const member of project.workspace.members) {
    addCandidate(map, member.user);
  }

  if (videoId) {
    const [folderMembers, videoMembers] = await Promise.all([
      db.projectFolderMember.findMany({
        where: { folder: { projectId } },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
      }),
      db.videoMember.findMany({
        where: { videoId },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
      }),
    ]);
    for (const member of [...folderMembers, ...videoMembers]) addCandidate(map, member.user);
    const entries = [...map.values()];
    for (let i = 0; i < entries.length; i += 16) {
      await Promise.all(
        entries.slice(i, i + 16).map(async (candidate) => {
          if (
            !(await db.video.count({
              where: { id: videoId, AND: visibleVideoWhere(candidate.id, false, false) },
            }))
          )
            map.delete(candidate.id);
        })
      );
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const aLabel = (a.name || a.email || '').toLowerCase();
    const bLabel = (b.name || b.email || '').toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}
