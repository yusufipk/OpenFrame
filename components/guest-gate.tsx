'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Client component that gates content behind a guest name prompt.
 * If the user already has a name in localStorage, it skips the gate.
 * Only renders children after the guest confirms their name.
 */
export function GuestGate({ children }: { children: ReactNode }) {
  const [guestName, setGuestName] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('openframe_guest_name') ?? '';
  });
  const [confirmed, setConfirmed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return Boolean(localStorage.getItem('openframe_guest_name'));
  });

  if (confirmed) {
    return <>{children}</>;
  }

  const confirm = () => {
    const trimmed = guestName.trim();
    if (!trimmed || trimmed.length > 100) return;
    localStorage.setItem('openframe_guest_name', trimmed);
    setConfirmed(true);
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm mx-auto p-6">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
            <User className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold mb-1">Welcome to OpenFrame</h1>
          <p className="text-sm text-muted-foreground">
            Enter your name to view and comment on this project
          </p>
        </div>
        <div className="space-y-3">
          <Input
            placeholder="Your name"
            value={guestName}
            maxLength={100}
            onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm();
            }}
            autoFocus
          />
          <Button
            className="w-full"
            disabled={!guestName.trim() || guestName.trim().length > 100}
            onClick={confirm}
          >
            Continue
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">
          Or{' '}
          <Link href="/login" className="underline hover:text-foreground">
            sign in
          </Link>{' '}
          with your account
        </p>
      </div>
    </div>
  );
}
