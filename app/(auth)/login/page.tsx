import Link from 'next/link';
import { Video } from 'lucide-react';
import { LoginForm, LoginFormSkeleton } from './login-form';
import { Suspense } from 'react';

export default function LoginPage() {
  const googleEnabled = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
  const githubEnabled = Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <Video className="h-8 w-8 text-primary" />
          <span className="font-bold text-2xl">OpenFrame</span>
        </Link>

        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm googleEnabled={googleEnabled} githubEnabled={githubEnabled} />
        </Suspense>

        <p className="text-center text-xs text-muted-foreground mt-4">
          By continuing, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}

