'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Globe, Lock, UserPlus, FolderPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type Visibility = 'PRIVATE' | 'INVITE' | 'PUBLIC';

const visibilityOptions: { value: Visibility; label: string; description: string; icon: React.ReactNode }[] = [
  {
    value: 'PRIVATE',
    label: 'Private',
    description: 'Only you can access this project',
    icon: <Lock className="h-5 w-5" />,
  },
  {
    value: 'INVITE',
    label: 'Invite Only',
    description: 'Share with specific people via email',
    icon: <UserPlus className="h-5 w-5" />,
  },
  {
    value: 'PUBLIC',
    label: 'Public',
    description: 'Anyone with the link can view',
    icon: <Globe className="h-5 w-5" />,
  },
];

export default function NewProjectPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    visibility: 'PRIVATE' as Visibility,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to create project');
        return;
      }

      router.push(`/projects/${data.id}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-xl">
        <div className="mb-8">
          <Link
            href="/dashboard"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Projects
          </Link>
        </div>

        <Card className="border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <FolderPlus className="h-7 w-7 text-primary" />
            </div>
            <CardTitle className="text-2xl">Create New Project</CardTitle>
            <CardDescription className="text-base">
              Set up a new project to organize your videos and collect feedback
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm font-medium">
                  Project Name
                </Label>
                <Input
                  id="name"
                  placeholder="e.g. Product Demo Q1"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description" className="text-sm font-medium">
                  Description
                  <span className="text-muted-foreground font-normal ml-1">(optional)</span>
                </Label>
                <Textarea
                  id="description"
                  placeholder="Brief description of what this project is about..."
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  disabled={isLoading}
                  className="resize-none"
                />
              </div>

              <div className="space-y-3">
                <Label className="text-sm font-medium">Who can access?</Label>
                <div className="grid gap-3">
                  {visibilityOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, visibility: option.value }))}
                      disabled={isLoading}
                      className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${formData.visibility === option.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                          : 'border-border hover:border-border/80 hover:bg-accent/50'
                        }`}
                    >
                      <div className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${formData.visibility === option.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                        }`}>
                        {option.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{option.label}</div>
                        <div className="text-sm text-muted-foreground">
                          {option.description}
                        </div>
                      </div>
                      <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${formData.visibility === option.value
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/30'
                        }`}>
                        {formData.visibility === option.value && (
                          <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  {error}
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <Button
                  type="submit"
                  disabled={isLoading || !formData.name.trim()}
                  className="flex-1 h-11"
                >
                  {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Project
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.back()}
                  className="h-11 px-6"
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
