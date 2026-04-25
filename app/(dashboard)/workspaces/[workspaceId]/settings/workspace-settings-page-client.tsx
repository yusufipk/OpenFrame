'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Building2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface WorkspaceData {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  ownerId: string;
}

export default function WorkspaceSettingsPageClient({
  workspaceId,
  canDelete,
}: {
  workspaceId: string;
  canDelete: boolean;
}) {
  const router = useRouter();

  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const fetchWorkspace = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`);
      if (!res.ok) {
        router.push('/dashboard');
        return;
      }
      const data = await res.json();
      const workspace = data.data;
      setWorkspace(workspace);
      setFormData({
        name: workspace.name,
        description: workspace.description || '',
      });
    } catch {
      setError('Failed to load workspace');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, router]);

  useEffect(() => {
    fetchWorkspace();
  }, [fetchWorkspace]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update workspace');
        return;
      }

      setSuccess('Workspace updated successfully');
    } catch {
      setError('Something went wrong');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!workspace) return;
    if (deleteConfirmation !== workspace.name) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to delete workspace');
        return;
      }

      router.push('/workspaces');
    } catch {
      setError('Failed to delete workspace');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!workspace) return null;

  return (
    <div className="px-6 lg:px-8 py-8 w-full max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href={`/workspaces/${workspaceId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Workspace
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Workspace Settings</h1>
        <p className="text-muted-foreground mt-1">Manage workspace configuration</p>
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            General
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Workspace Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                disabled={isSaving}
              />
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {success && (
              <div className="rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
                {success}
              </div>
            )}

            <Button type="submit" disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {canDelete ? (
        <>
          <Separator className="my-8" />

          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Danger Zone</CardTitle>
              <CardDescription>Irreversible actions. Proceed with caution.</CardDescription>
            </CardHeader>
            <CardContent>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Workspace
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete &quot;{workspace.name}&quot;?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-4">
                        <p>
                          This will permanently delete this workspace and everything inside it
                          (projects, videos, comments, images, and voice notes). This action cannot
                          be undone.
                        </p>
                        <div className="space-y-2">
                          <Label htmlFor="delete-workspace-confirm">
                            Type <strong className="text-foreground">{workspace.name}</strong> to
                            confirm
                          </Label>
                          <Input
                            id="delete-workspace-confirm"
                            value={deleteConfirmation}
                            onChange={(e) => setDeleteConfirmation(e.target.value)}
                            placeholder="Workspace name"
                            className="h-11"
                          />
                        </div>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => setDeleteConfirmation('')}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleteConfirmation !== workspace.name || isDeleting}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Delete Workspace
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
