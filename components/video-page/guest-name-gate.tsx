'use client';

import { memo } from 'react';
import Link from 'next/link';
import { User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface GuestNameGateProps {
  guestName: string;
  setGuestName: (value: string) => void;
  onConfirm: () => void;
}

export const GuestNameGate = memo(function GuestNameGate({
  guestName,
  setGuestName,
  onConfirm,
}: GuestNameGateProps) {
  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm mx-auto p-6">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
            <User className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold mb-1">Welcome to OpenFrame</h1>
          <p className="text-sm text-muted-foreground">
            Enter your name to view and comment on this video
          </p>
        </div>
        <div className="space-y-3">
          <Input
            placeholder="Your name"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && guestName.trim()) {
                onConfirm();
              }
            }}
            autoFocus
          />
          <Button className="w-full" disabled={!guestName.trim()} onClick={onConfirm}>
            Continue
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">
          Or{' '}
          <Link href="/login" className="text-primary hover:underline">
            sign in
          </Link>{' '}
          for a full account
        </p>
      </div>
    </div>
  );
});
