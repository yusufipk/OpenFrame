import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from './onboarding-wizard';

export default async function OnboardingPage() {
    const session = await auth();
    if (!session?.user?.id) {
        redirect('/login');
    }

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { onboardingCompletedAt: true, name: true, email: true },
    });

    if (user?.onboardingCompletedAt) {
        redirect('/dashboard');
    }

    const userName = user?.name || user?.email?.split('@')[0] || 'there';

    return <OnboardingWizard userName={userName} />;
}
