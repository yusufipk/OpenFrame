'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Video, Loader2, KeyRound, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function RegisterPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const invitationToken = useMemo(() => searchParams.get('invitationToken') || '', [searchParams]);
    const invitedEmail = useMemo(() => searchParams.get('email') || '', [searchParams]);
    const isInvitationFlow = invitationToken.length > 0;
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        password: '',
        confirmPassword: '',
        inviteCode: '',
    });

    useEffect(() => {
        if (!invitedEmail) return;
        setFormData((prev) => ({
            ...prev,
            email: invitedEmail,
        }));
    }, [invitedEmail]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData(prev => ({
            ...prev,
            [e.target.name]: e.target.value,
        }));
        setError('');
    };

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        // Client-side validation
        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match');
            setIsLoading(false);
            return;
        }

        if (formData.password.length < 8) {
            setError('Password must be at least 8 characters');
            setIsLoading(false);
            return;
        }

        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: formData.name,
                    email: formData.email,
                    password: formData.password,
                    inviteCode: formData.inviteCode || undefined,
                    invitationToken: invitationToken || undefined,
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.error || 'Registration failed');
                return;
            }

            // Redirect to login on success
            router.push('/login?registered=true');
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
            <div className="w-full max-w-md">
                {/* Logo */}
                <Link href="/" className="flex items-center justify-center gap-2 mb-8">
                    <Video className="h-8 w-8 text-primary" />
                    <span className="font-bold text-2xl">OpenFrame</span>
                </Link>

                <Card>
                    <CardHeader className="text-center">
                        <CardTitle className="flex items-center justify-center gap-2">
                            <UserPlus className="h-5 w-5" />
                            Create Account
                        </CardTitle>
                        <CardDescription>
                            Join OpenFrame to collaborate on video projects
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleRegister} className="space-y-4">
                            {/* Invite Code - First and prominent */}
                            {isInvitationFlow ? (
                                <div className="p-3 rounded-md bg-primary/10 text-sm">
                                    You are registering via an invitation link.
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-2">
                                        <Label htmlFor="inviteCode" className="flex items-center gap-2">
                                            <KeyRound className="h-4 w-4 text-amber-500" />
                                            Invite Code
                                        </Label>
                                        <Input
                                            id="inviteCode"
                                            name="inviteCode"
                                            type="text"
                                            placeholder="Enter your invite code"
                                            value={formData.inviteCode}
                                            onChange={handleChange}
                                            required
                                            disabled={isLoading}
                                            className="border-amber-500/30 focus:border-amber-500"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            An invite code is required to create an account
                                        </p>
                                    </div>

                                    <div className="h-px bg-border my-4" />
                                </>
                            )}

                            <div className="space-y-2">
                                <Label htmlFor="name">Full Name</Label>
                                <Input
                                    id="name"
                                    name="name"
                                    type="text"
                                    placeholder="John Doe"
                                    value={formData.name}
                                    onChange={handleChange}
                                    required
                                    disabled={isLoading}
                                    minLength={2}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="email">Email</Label>
                                <Input
                                    id="email"
                                    name="email"
                                    type="email"
                                    placeholder="you@example.com"
                                    value={formData.email}
                                    onChange={handleChange}
                                    required
                                    disabled={isLoading}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="password">Password</Label>
                                <Input
                                    id="password"
                                    name="password"
                                    type="password"
                                    placeholder="••••••••"
                                    value={formData.password}
                                    onChange={handleChange}
                                    required
                                    disabled={isLoading}
                                    minLength={8}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="confirmPassword">Confirm Password</Label>
                                <Input
                                    id="confirmPassword"
                                    name="confirmPassword"
                                    type="password"
                                    placeholder="••••••••"
                                    value={formData.confirmPassword}
                                    onChange={handleChange}
                                    required
                                    disabled={isLoading}
                                />
                            </div>

                            {error && (
                                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                                    {error}
                                </div>
                            )}

                            <Button type="submit" className="w-full" disabled={isLoading}>
                                {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                Create Account
                            </Button>
                        </form>

                        <p className="text-center text-sm text-muted-foreground mt-6">
                            Already have an account?{' '}
                            <Link href="/login" className="text-primary hover:underline">
                                Sign in
                            </Link>
                        </p>
                    </CardContent>
                </Card>

                <p className="text-center text-xs text-muted-foreground mt-4">
                    By continuing, you agree to our Terms of Service and Privacy Policy
                </p>
            </div>
        </div>
    );
}
