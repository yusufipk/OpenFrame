import { requireAuthOrRedirect } from '@/lib/route-access';
import FeedbackPageClient from './feedback-page-client';

export default async function FeedbackPage() {
  await requireAuthOrRedirect();
  return <FeedbackPageClient />;
}
