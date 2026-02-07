'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Globe, Lock, UserPlus, Trash2, AlertTriangle, Settings, Save, Tag, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface ProjectSettingsPageProps {
    params: Promise<{ projectId: string }>;
}

interface CommentTag {
    id: string;
    name: string;
    color: string;
    position: number;
}

export default function ProjectSettingsPage({ params }: ProjectSettingsPageProps) {
    const router = useRouter();
    const [projectId, setProjectId] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [deleteConfirmation, setDeleteConfirmation] = useState('');
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        visibility: 'PRIVATE' as Visibility,
    });

    // Tag management state
    const [tags, setTags] = useState<CommentTag[]>([]);
    const [newTagName, setNewTagName] = useState('');
    const [newTagColor, setNewTagColor] = useState('#3B82F6');
    const [isAddingTag, setIsAddingTag] = useState(false);
    const [editingTagId, setEditingTagId] = useState<string | null>(null);
    const [editTagName, setEditTagName] = useState('');
    const [editTagColor, setEditTagColor] = useState('');

    useEffect(() => {
        params.then(({ projectId: id }) => {
            setProjectId(id);
            // Fetch project data
            fetch(`/api/projects/${id}`)
                .then((res) => res.json())
                .then((data) => {
                    if (data.error) {
                        setError(data.error);
                    } else {
                        setFormData({
                            name: data.name || '',
                            description: data.description || '',
                            visibility: data.visibility || 'PRIVATE',
                        });
                    }
                })
                .catch(() => setError('Failed to load project'))
                .finally(() => setIsLoading(false));

            // Fetch tags
            fetch(`/api/projects/${id}/tags`)
                .then((res) => res.json())
                .then((data) => {
                    if (Array.isArray(data)) {
                        setTags(data);
                    }
                })
                .catch(() => { /* Silent fail - tags are optional */ });
        });
    }, [params]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setError('');
        setSuccess('');

        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.error || 'Failed to update project');
                return;
            }

            setSuccess('Project settings saved successfully');
            setTimeout(() => setSuccess(''), 3000);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleAddTag = async () => {
        if (!newTagName.trim()) return;
        setIsAddingTag(true);
        try {
            const res = await fetch(`/api/projects/${projectId}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
            });
            if (res.ok) {
                const newTag = await res.json();
                setTags([...tags, newTag]);
                setNewTagName('');
                setNewTagColor('#3B82F6');
            }
        } catch {
            // Silent fail
        } finally {
            setIsAddingTag(false);
        }
    };

    const handleUpdateTag = async (tagId: string) => {
        if (!editTagName.trim()) return;
        try {
            const res = await fetch(`/api/projects/${projectId}/tags/${tagId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editTagName.trim(), color: editTagColor }),
            });
            if (res.ok) {
                const updated = await res.json();
                setTags(tags.map((t) => (t.id === tagId ? updated : t)));
                setEditingTagId(null);
            }
        } catch {
            // Silent fail
        }
    };

    const handleDeleteTag = async (tagId: string) => {
        try {
            const res = await fetch(`/api/projects/${projectId}/tags/${tagId}`, {
                method: 'DELETE',
            });
            if (res.ok) {
                setTags(tags.filter((t) => t.id !== tagId));
            }
        } catch {
            // Silent fail
        }
    };

    const handleDelete = async () => {
        if (deleteConfirmation !== formData.name) {
            setError('Project name does not match');
            return;
        }

        setIsDeleting(true);
        setError('');

        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const data = await response.json();
                setError(data.error || 'Failed to delete project');
                return;
            }

            router.push('/dashboard');
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setIsDeleting(false);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="min-h-[calc(100vh-4rem)] flex items-start justify-center py-12 px-4">
            <div className="w-full max-w-xl">
                <div className="mb-8">
                    <Link
                        href={`/projects/${projectId}`}
                        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <ArrowLeft className="h-4 w-4 mr-1" />
                        Back to Project
                    </Link>
                </div>

                <div className="space-y-6">
                    {/* General Settings */}
                    <Card className="border-border/50 shadow-lg">
                        <CardHeader className="text-center pb-2">
                            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                                <Settings className="h-7 w-7 text-primary" />
                            </div>
                            <CardTitle className="text-2xl">Project Settings</CardTitle>
                            <CardDescription className="text-base">
                                Update your project details and access settings
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="pt-6">
                            <form onSubmit={handleSave} className="space-y-6">
                                <div className="space-y-2">
                                    <Label htmlFor="name" className="text-sm font-medium">
                                        Project Name
                                    </Label>
                                    <Input
                                        id="name"
                                        value={formData.name}
                                        onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                        required
                                        disabled={isSaving}
                                        className="h-11"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="description" className="text-sm font-medium">
                                        Description
                                    </Label>
                                    <Textarea
                                        id="description"
                                        value={formData.description}
                                        onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                                        rows={3}
                                        disabled={isSaving}
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
                                                disabled={isSaving}
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

                                {success && (
                                    <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm flex items-center gap-2">
                                        <Save className="h-4 w-4" />
                                        {success}
                                    </div>
                                )}

                                <Button type="submit" disabled={isSaving || !formData.name.trim()} className="h-11">
                                    {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                    Save Changes
                                </Button>
                            </form>
                        </CardContent>
                    </Card>

                    {/* Comment Tags */}
                    <Card id="comment-tags" className="border-border/50 shadow-lg">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-lg flex items-center gap-2">
                                <Tag className="h-5 w-5" />
                                Comment Tags
                            </CardTitle>
                            <CardDescription>
                                Customize tags for categorizing comments on videos
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {/* Existing tags */}
                            <div className="space-y-2">
                                {tags.map((tag) => (
                                    <div key={tag.id} className="flex items-center gap-2 p-2 rounded-lg border bg-card">
                                        {editingTagId === tag.id ? (
                                            <>
                                                <input
                                                    type="color"
                                                    value={editTagColor}
                                                    onChange={(e) => setEditTagColor(e.target.value)}
                                                    className="w-8 h-8 rounded cursor-pointer border-0"
                                                />
                                                <Input
                                                    value={editTagName}
                                                    onChange={(e) => setEditTagName(e.target.value)}
                                                    className="flex-1 h-8"
                                                    onKeyDown={(e) => e.key === 'Enter' && handleUpdateTag(tag.id)}
                                                />
                                                <Button size="sm" variant="ghost" onClick={() => handleUpdateTag(tag.id)}>
                                                    <Save className="h-4 w-4" />
                                                </Button>
                                                <Button size="sm" variant="ghost" onClick={() => setEditingTagId(null)}>
                                                    <X className="h-4 w-4" />
                                                </Button>
                                            </>
                                        ) : (
                                            <>
                                                <div
                                                    className="w-6 h-6 rounded-full shrink-0"
                                                    style={{ backgroundColor: tag.color }}
                                                />
                                                <span className="flex-1 text-sm font-medium">{tag.name}</span>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => {
                                                        setEditingTagId(tag.id);
                                                        setEditTagName(tag.name);
                                                        setEditTagColor(tag.color);
                                                    }}
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-destructive hover:text-destructive"
                                                    onClick={() => handleDeleteTag(tag.id)}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {/* Add new tag */}
                            <div className="flex items-center gap-2 pt-2 border-t">
                                <input
                                    type="color"
                                    value={newTagColor}
                                    onChange={(e) => setNewTagColor(e.target.value)}
                                    className="w-8 h-8 rounded cursor-pointer border-0"
                                />
                                <Input
                                    placeholder="New tag name..."
                                    value={newTagName}
                                    onChange={(e) => setNewTagName(e.target.value)}
                                    className="flex-1 h-8"
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                                />
                                <Button size="sm" onClick={handleAddTag} disabled={!newTagName.trim() || isAddingTag}>
                                    {isAddingTag ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Danger Zone */}
                    <Card className="border-destructive/30 shadow-lg">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-lg text-destructive flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5" />
                                Danger Zone
                            </CardTitle>
                            <CardDescription>
                                Irreversible actions that will permanently affect your project
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 rounded-xl border border-destructive/20 bg-destructive/5">
                                <div>
                                    <h4 className="font-medium">Delete this project</h4>
                                    <p className="text-sm text-muted-foreground">
                                        This action cannot be undone
                                    </p>
                                </div>
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button variant="destructive" size="sm">
                                            <Trash2 className="h-4 w-4 mr-2" />
                                            Delete
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>Delete &quot;{formData.name}&quot;?</AlertDialogTitle>
                                            <AlertDialogDescription asChild>
                                                <div className="space-y-4">
                                                    <p>
                                                        This will permanently delete this project and all of its
                                                        videos, versions, and comments. This action cannot be undone.
                                                    </p>
                                                    <div className="space-y-2">
                                                        <Label htmlFor="delete-confirm">
                                                            Type <strong className="text-foreground">{formData.name}</strong> to confirm
                                                        </Label>
                                                        <Input
                                                            id="delete-confirm"
                                                            value={deleteConfirmation}
                                                            onChange={(e) => setDeleteConfirmation(e.target.value)}
                                                            placeholder="Project name"
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
                                                disabled={deleteConfirmation !== formData.name || isDeleting}
                                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                            >
                                                {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                                Delete Project
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
