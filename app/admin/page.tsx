import { Metadata } from 'next';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { isBunnyUploadsFeatureEnabled, isStripeBillingEnabled } from '@/lib/feature-flags';
import { redirect } from 'next/navigation';
import {
  getCachedBunnyStorageStats,
  getCachedTotalStorage,
  getCachedStripeStats,
} from '@/lib/admin-stats';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshR2StatsButton } from '@/components/admin/refresh-r2-stats-button';
import {
  Users,
  Folder,
  Video,
  MessageSquare,
  Mic,
  HardDrive,
  Image as ImageIcon,
  Film,
  MessageSquareQuote,
  Star,
  CreditCard,
  TrendingUp,
  UserCheck,
  AlertCircle,
  UserX,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Admin Dashboard | OpenFrame',
  description: 'Admin overview dashboard',
};

function formatBytes(bytes: number, decimals = 2) {
  if (bytes < 0) return 'Error Fetching';
  if (!+bytes) return '0 Bytes';
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatMrr(cents: number, currency: string) {
  const safeCurrency = /^[a-zA-Z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: safeCurrency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export default async function AdminDashboardPage() {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  const userFeedbackDelegate = (
    db as unknown as {
      userFeedback?: { count: (args?: unknown) => Promise<number> };
    }
  ).userFeedback;

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
      where: { voiceUrl: { not: null } },
    }),
    db.comment.count({
      where: { imageUrl: { not: null } },
    }),
  ]);

  let totalFeedback = 0;
  let totalReviews = 0;
  if (userFeedbackDelegate) {
    try {
      [totalFeedback, totalReviews] = await Promise.all([
        userFeedbackDelegate.count({
          where: { type: 'FEEDBACK' },
        }),
        userFeedbackDelegate.count({
          where: { type: 'REVIEW' },
        }),
      ]);
    } catch (error) {
      console.error('Failed to fetch feedback stats:', error);
    }
  }

  // 2. Storage Stats (Cached)
  const [totalStorageBytes, bunnyStorageStats, stripeStats] = await Promise.all([
    getCachedTotalStorage(),
    getCachedBunnyStorageStats(),
    getCachedStripeStats(),
  ]);

  return (
    <div className="flex-1 space-y-4 px-4 md:px-8">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Dashboard Overview</h2>
        <RefreshR2StatsButton />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalUsers}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Workspaces & Projects</CardTitle>
            <Folder className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalProjects}</div>
            <p className="text-xs text-muted-foreground">Total active projects on the platform</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Videos</CardTitle>
            <Video className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalVideos}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Comments</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalComments}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Voice Recordings</CardTitle>
            <Mic className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalVoiceComments}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Image Attachments</CardTitle>
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalImageComments}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Feedback Submissions</CardTitle>
            <MessageSquareQuote className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalFeedback}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Review Submissions</CardTitle>
            <Star className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalReviews}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cloudflare R2 Storage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(totalStorageBytes)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bunny Stream Storage</CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isBunnyUploadsFeatureEnabled()
                ? formatBytes(bunnyStorageStats.totalBytes)
                : 'Disabled'}
            </div>
          </CardContent>
        </Card>
      </div>

      {isStripeBillingEnabled() && stripeStats && (
        <>
          <h3 className="text-xl font-semibold tracking-tight pt-2">Billing &amp; Revenue</h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Monthly Recurring Revenue</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatMrr(stripeStats.mrrCents, stripeStats.currency)}
                </div>
                <p className="text-xs text-muted-foreground">Based on active subscriptions</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Active Subscribers</CardTitle>
                <UserCheck className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stripeStats.activeSubscribers}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">On Trial</CardTitle>
                <CreditCard className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stripeStats.trialingUsers}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Free Users</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stripeStats.freeUsers}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Past Due</CardTitle>
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stripeStats.pastDueUsers}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Canceled</CardTitle>
                <UserX className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stripeStats.canceledUsers}</div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
