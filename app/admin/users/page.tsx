import { Metadata } from 'next';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getCachedUserMediaStorage } from '@/lib/admin-stats';
import { HardDrive } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { format } from 'date-fns';

export const metadata: Metadata = {
    title: 'Manage Users | Admin',
};

function formatBytes(bytes: number, decimals = 2) {
    if (bytes < 0) return 'Error Fetching';
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default async function AdminUsersPage({
    searchParams
}: {
    searchParams: { page?: string }
}) {
    const session = await auth();
    if (!session?.user?.isAdmin) {
        redirect('/');
    }

    const page = Number(searchParams?.page) || 1;
    const pageSize = 20;
    const skip = (page - 1) * pageSize;

    // Fetch users with their counts and total count
    const [users, totalUsers] = await Promise.all([
        db.user.findMany({
            skip,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true,
                _count: {
                    select: {
                        ownedWorkspaces: true,
                        projects: true,
                        comments: true,
                    }
                }
            }
        }),
        db.user.count()
    ]);

    const totalPages = Math.ceil(totalUsers / pageSize);

    // Determine media storage per user (Cached)
    const userStorage = await getCachedUserMediaStorage();

    return (
        <div className="flex-1 space-y-4 px-4 md:px-8">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Users</h2>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Users</CardTitle>
                    <CardDescription>
                        A comprehensive list of all {totalUsers} users registered on the platform.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>User</TableHead>
                                    <TableHead>Joined Date</TableHead>
                                    <TableHead className="text-center">Workspaces Owned</TableHead>
                                    <TableHead className="text-center">Projects Owned</TableHead>
                                    <TableHead className="text-center">Total Comments</TableHead>
                                    <TableHead className="text-right">Media Storage</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {users.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="h-24 text-center">
                                            No users found.
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    users.map((user) => (
                                        <TableRow key={user.id}>
                                            <TableCell>
                                                <div className="flex flex-col">
                                                    <span className="font-medium">{user.name || 'Anonymous'}</span>
                                                    <span className="text-xs text-muted-foreground">{user.email}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                {format(new Date(user.createdAt), 'MMM dd, yyyy')}
                                            </TableCell>
                                            <TableCell className="text-center">{user._count.ownedWorkspaces}</TableCell>
                                            <TableCell className="text-center">{user._count.projects}</TableCell>
                                            <TableCell className="text-center">{user._count.comments}</TableCell>
                                            <TableCell className="text-right text-sm">
                                                <div className="flex flex-col items-end">
                                                    <span className="font-medium text-foreground">{formatBytes(userStorage[user.id]?.total || 0)}</span>
                                                    {(userStorage[user.id]?.voice > 0 || userStorage[user.id]?.image > 0) && (
                                                        <span className="text-xs text-muted-foreground mt-0.5 whitespace-nowrap space-x-1">
                                                            {userStorage[user.id]?.voice > 0 && <span>🎤 {formatBytes(userStorage[user.id]?.voice)}</span>}
                                                            {userStorage[user.id]?.voice > 0 && userStorage[user.id]?.image > 0 && <span>•</span>}
                                                            {userStorage[user.id]?.image > 0 && <span>🖼️ {formatBytes(userStorage[user.id]?.image)}</span>}
                                                        </span>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </div>
                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-end space-x-2 py-4">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page <= 1}
                                asChild={page > 1}
                            >
                                {page > 1 ? (
                                    <Link href={`/admin/users?page=${page - 1}`}>Previous</Link>
                                ) : (
                                    "Previous"
                                )}
                            </Button>
                            <span className="text-sm font-medium">
                                Page {page} of {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page >= totalPages}
                                asChild={page < totalPages}
                            >
                                {page < totalPages ? (
                                    <Link href={`/admin/users?page=${page + 1}`}>Next</Link>
                                ) : (
                                    "Next"
                                )}
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
