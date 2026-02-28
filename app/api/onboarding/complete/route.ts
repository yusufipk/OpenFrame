import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';

export async function POST() {
    const session = await auth();
    if (!session?.user?.id) {
        return apiErrors.unauthorized();
    }

    await db.user.update({
        where: { id: session.user.id },
        data: { onboardingCompletedAt: new Date() },
    });

    return successResponse({ completed: true });
}
