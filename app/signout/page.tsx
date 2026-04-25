'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SignOutPage() {
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    setLoading(true);
    await signOut({ callbackUrl: '/login' });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <LogOut className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-2xl">Sign out</CardTitle>
          <CardDescription>Are you sure you want to sign out?</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button onClick={handleSignOut} disabled={loading} className="w-full">
            {loading ? 'Signing out...' : 'Sign out'}
          </Button>
          <Button variant="outline" asChild className="w-full">
            <a href="/dashboard">Cancel</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
