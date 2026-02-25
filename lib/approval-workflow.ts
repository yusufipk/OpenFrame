import { db } from '@/lib/db';

export interface ApprovalCandidate {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

function addCandidate(map: Map<string, ApprovalCandidate>, user: ApprovalCandidate | null | undefined) {
  if (!user) return;
  map.set(user.id, user);
}

export async function getApprovalCandidatesForProject(projectId: string): Promise<ApprovalCandidate[] | null> {
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

  return Array.from(map.values()).sort((a, b) => {
    const aLabel = (a.name || a.email || '').toLowerCase();
    const bLabel = (b.name || b.email || '').toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}
