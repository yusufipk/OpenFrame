'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Copy,
  Check,
  Loader2,
  UserPlus,
  Share2,
  Globe,
  Lock,
  Mail,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface ProjectMember {
  id: string;
  role: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

interface ProjectSharePageProps {
  projectId: string;
}

export default function ProjectSharePageClient({ projectId }: ProjectSharePageProps) {
  const [projectName, setProjectName] = useState('');
  const [projectVisibility, setProjectVisibility] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState('');

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          const project = data.data;
          setProjectName(project.name || '');
          setProjectVisibility(project.visibility || 'PRIVATE');
          setMembers(project.members || []);
        }
      })
      .catch(() => setError('Failed to load project'))
      .finally(() => setIsLoading(false));
  }, [projectId]);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getDirectLink = () => {
    if (typeof window !== 'undefined') {
      return `${window.location.origin}/projects/${projectId}`;
    }
    return `/projects/${projectId}`;
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setIsInviting(true);
    setError('');
    setInviteSuccess('');

    try {
      // TODO: Implement invite API
      await new Promise((resolve) => setTimeout(resolve, 500));
      setInviteSuccess(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
      setTimeout(() => setInviteSuccess(''), 3000);
    } catch {
      setError('Failed to send invitation');
    } finally {
      setIsInviting(false);
    }
  };

  const VisibilityIcon = () => {
    switch (projectVisibility) {
      case 'PUBLIC':
        return <Globe className="h-5 w-5" />;
      case 'INVITE':
        return <UserPlus className="h-5 w-5" />;
      default:
        return <Lock className="h-5 w-5" />;
    }
  };

  const getVisibilityColor = () => {
    switch (projectVisibility) {
      case 'PUBLIC':
        return 'bg-green-500/10 text-green-500';
      case 'INVITE':
        return 'bg-blue-500/10 text-blue-500';
      default:
        return 'bg-orange-500/10 text-orange-500';
    }
  };

  const getVisibilityLabel = () => {
    switch (projectVisibility) {
      case 'PUBLIC':
        return { title: 'Public', description: 'Anyone with the link can view this project' };
      case 'INVITE':
        return { title: 'Invite Only', description: 'Only people you invite can access' };
      default:
        return { title: 'Private', description: 'Only you can access this project' };
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const visibilityInfo = getVisibilityLabel();

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
          {/* Header Card */}
          <Card className="border-border/50 shadow-lg">
            <CardHeader className="text-center pb-2">
              <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Share2 className="h-7 w-7 text-primary" />
              </div>
              <CardTitle className="text-2xl">Share Project</CardTitle>
              <CardDescription className="text-base">
                Share &quot;{projectName}&quot; with your team or clients
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              {/* Visibility Status */}
              <div className={`flex items-center gap-3 p-4 rounded-xl ${getVisibilityColor()}`}>
                <div className="w-10 h-10 rounded-lg bg-current/10 flex items-center justify-center">
                  <VisibilityIcon />
                </div>
                <div className="flex-1">
                  <div className="font-medium">{visibilityInfo.title}</div>
                  <div className="text-sm opacity-80">{visibilityInfo.description}</div>
                </div>
                <Link href={`/projects/${projectId}/settings`}>
                  <Button variant="ghost" size="sm" className="text-current hover:bg-current/10">
                    Change
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>

          {/* Invite People - Only show for INVITE visibility */}
          {projectVisibility === 'INVITE' && (
            <Card className="border-border/50 shadow-lg">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mail className="h-5 w-5 text-primary" />
                  Invite People
                </CardTitle>
                <CardDescription>Send email invitations to specific people</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={handleInvite} className="flex gap-2">
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="h-11 flex-1"
                    disabled={isInviting}
                  />
                  <Button
                    type="submit"
                    disabled={isInviting || !inviteEmail.trim()}
                    className="h-11"
                  >
                    {isInviting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <UserPlus className="h-4 w-4 mr-2" />
                        Invite
                      </>
                    )}
                  </Button>
                </form>

                {inviteSuccess && (
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm">
                    {inviteSuccess}
                  </div>
                )}

                {/* Current Members */}
                {members.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <Label className="text-sm text-muted-foreground">Project Members</Label>
                    <div className="space-y-2">
                      {members.map((member) => (
                        <div
                          key={member.id}
                          className="flex items-center justify-between p-3 rounded-xl border bg-card"
                        >
                          <div className="flex items-center gap-3">
                            <Avatar className="h-9 w-9">
                              <AvatarFallback className="text-xs">
                                {member.user.name?.charAt(0) || member.user.email?.charAt(0) || '?'}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <div className="font-medium text-sm">
                                {member.user.name || 'Unknown'}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {member.user.email}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="text-xs capitalize">
                              {member.role.toLowerCase()}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {members.length === 0 && (
                  <div className="text-center py-6 text-muted-foreground">
                    <UserPlus className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No members yet</p>
                    <p className="text-xs opacity-70">
                      Invite people to collaborate on this project
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Public Link - Only show for PUBLIC visibility */}
          {projectVisibility === 'PUBLIC' && (
            <Card className="border-border/50 shadow-lg">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Globe className="h-5 w-5 text-primary" />
                  Public Link
                </CardTitle>
                <CardDescription>Share this link with anyone</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    value={getDirectLink()}
                    readOnly
                    className="font-mono text-sm h-11 bg-muted/50"
                  />
                  <Button
                    variant={copied ? 'default' : 'outline'}
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={() => copyToClipboard(getDirectLink())}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Private notice */}
          {projectVisibility === 'PRIVATE' && (
            <Card className="border-border/50 shadow-lg">
              <CardContent className="py-8">
                <div className="text-center">
                  <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                    <Lock className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                  <h3 className="font-medium mb-1">This project is private</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Only you can access this project. Change visibility to share with others.
                  </p>
                  <Button asChild variant="outline">
                    <Link href={`/projects/${projectId}/settings`}>Change Visibility</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {error && (
            <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
