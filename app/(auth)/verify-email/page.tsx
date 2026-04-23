'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Video, Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const emailParam = searchParams.get('email') || '';
  const [resendEmail, setResendEmail] = useState(emailParam);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/verify-email/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <Video className="h-8 w-8 text-primary" />
          <span className="font-bold text-2xl">OpenFrame</span>
        </Link>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2">
              <Mail className="h-5 w-5" />
              Check your email
            </CardTitle>
            <CardDescription>
              We sent a verification link to{' '}
              {emailParam ? <strong>{emailParam}</strong> : 'your email address'}. Click the link to
              activate your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              The link expires in 2 hours. Check your spam folder if you don&apos;t see it.
            </p>

            {sent ? (
              <div className="p-3 rounded-md bg-green-500/10 text-green-600 text-sm text-center">
                Verification email resent! Check your inbox.
              </div>
            ) : (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">
                      Didn&apos;t receive it?
                    </span>
                  </div>
                </div>

                {error && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {error}
                  </div>
                )}

                <form onSubmit={handleResend} className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="your@email.com"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    required
                    disabled={loading}
                    className="text-sm"
                  />
                  <Button type="submit" variant="outline" disabled={loading || !resendEmail}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Resend
                  </Button>
                </form>
              </>
            )}

            <p className="text-center text-sm text-muted-foreground">
              Already verified?{' '}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
