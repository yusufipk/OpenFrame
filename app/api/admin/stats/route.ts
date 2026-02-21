import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { getCachedTotalStorage } from '@/lib/admin-stats';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.isAdmin) {
            return new NextResponse('Unauthorized', { status: 403 });
        }

        // 1. Database Stats
        const [
            totalUsers,
            totalProjects,
            totalVideos,
            totalComments,
            totalVoiceComments,
            totalImageComments,
        ] = await Promise.all([
            db.user.count(),
            db.project.count(),
            db.video.count(),
            db.comment.count(),
            db.comment.count({
                where: {
                    voiceUrl: {
                        not: null,
                    }
                }
            }),
            db.comment.count({
                where: {
                    imageUrl: {
                        not: null,
                    }
                }
            })
        ]);

        // 2. Storage Stats (Cached)
        const totalStorageBytes = await getCachedTotalStorage();

        return NextResponse.json({
            totalUsers,
            totalProjects,
            totalVideos,
            totalComments,
            totalVoiceComments,
            totalImageComments,
            totalStorageBytes,
        });
    } catch (error) {
        console.error('[ADMIN_STATS_GET]', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
