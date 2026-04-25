'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from 'next-auth/react';

function getSafeCallbackUrl(value: string | null): string {
  if (!value) return '/dashboard';
  try {
    const baseOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const parsed = new URL(value, baseOrigin);
    if (parsed.origin !== baseOrigin) return '/dashboard';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/dashboard';
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  RegistrationClosed: 'Sign-up is currently invite-only. Contact an administrator.',
  // Generic message — avoid confirming whether a credentials account exists for this email
  OAuthAccountNotLinked: 'Sign-in failed. Please try a different method or contact support.',
  OAuthCallbackError: 'OAuth sign-in failed. Please try again.',
  OAuthEmailNotVerified:
    'Your OAuth account email is not verified. Please verify it with your provider and try again.',
  InvalidVerificationToken: 'The verification link is invalid or has expired.',
  VerificationFailed: 'Email verification failed. Please try again.',
  Default: 'Something went wrong. Please try again.',
};

interface LoginFormInnerProps {
  googleEnabled: boolean;
  githubEnabled: boolean;
}

function LoginFormInner({ googleEnabled, githubEnabled }: LoginFormInnerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const [showVerifiedSuccess, setShowVerifiedSuccess] = useState(false);
  const callbackUrl = getSafeCallbackUrl(searchParams.get('callbackUrl'));

  useEffect(() => {
    if (searchParams.get('registered') === 'true') {
      setShowSuccess(true);
    }
    if (searchParams.get('verified') === 'true') {
      setShowVerifiedSuccess(true);
    }
    const errorCode = searchParams.get('error');
    if (errorCode) {
      setError(ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.Default);
    }
  }, [searchParams]);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        setError('Invalid email or password');
        return;
      }

      const destination = getSafeCallbackUrl(result?.url || callbackUrl);
      router.push(destination);
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthLogin = async (provider: string) => {
    setOauthLoading(provider);
    setError('');
    await signIn(provider, { callbackUrl });
  };

  const hasOAuth = googleEnabled || githubEnabled;
  const anyLoading = isLoading || oauthLoading !== null;

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your account to continue</CardDescription>
      </CardHeader>
      <CardContent>
        {showSuccess && (
          <div className="p-3 rounded-md bg-green-500/10 text-green-600 text-sm mb-4">
            Account created successfully! Please check your email to verify your address before
            signing in.
          </div>
        )}

        {showVerifiedSuccess && (
          <div className="p-3 rounded-md bg-green-500/10 text-green-600 text-sm mb-4">
            Email verified successfully! You can now sign in.
          </div>
        )}

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm mb-4">
            {error}
          </div>
        )}

        {/* OAuth Buttons */}
        {hasOAuth && (
          <div className="space-y-2 mb-4">
            {googleEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={anyLoading}
                onClick={() => handleOAuthLogin('google')}
              >
                {oauthLoading === 'google' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                )}
                Continue with Google
              </Button>
            )}
            {githubEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={anyLoading}
                onClick={() => handleOAuthLogin('github')}
              >
                {oauthLoading === 'github' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <svg
                    className="h-4 w-4 mr-2"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    fill="currentColor"
                  >
                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                  </svg>
                )}
                Continue with GitHub
              </Button>
            )}
          </div>
        )}

        {/* Divider */}
        {hasOAuth && (
          <div className="relative mb-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or continue with email</span>
            </div>
          </div>
        )}

        {/* Email Form */}
        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
              }}
              required
              disabled={anyLoading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              required
              disabled={anyLoading}
            />
          </div>

          <Button type="submit" className="w-full" disabled={anyLoading}>
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Sign in
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function LoginFormSkeleton() {
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your account to continue</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-10 bg-muted animate-pulse rounded-md" />
        <div className="h-10 bg-muted animate-pulse rounded-md" />
        <div className="h-10 bg-primary/20 animate-pulse rounded-md" />
      </CardContent>
    </Card>
  );
}

export function LoginForm({ googleEnabled, githubEnabled }: LoginFormInnerProps) {
  return (
    <Suspense fallback={<LoginFormSkeleton />}>
      <LoginFormInner googleEnabled={googleEnabled} githubEnabled={githubEnabled} />
    </Suspense>
  );
}
