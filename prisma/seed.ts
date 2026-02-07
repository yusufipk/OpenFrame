import { PrismaClient, ProjectVisibility, ProjectMemberRole, SharePermission } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const { Pool } = pg;

// Create a direct Prisma client for seeding
const connectionString = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('🌱 Seeding database...');

    // Clean up existing data (in reverse order of dependencies)
    await prisma.comment.deleteMany();
    await prisma.videoVersion.deleteMany();
    await prisma.video.deleteMany();
    await prisma.shareLink.deleteMany();
    await prisma.projectMember.deleteMany();
    await prisma.project.deleteMany();
    await prisma.session.deleteMany();
    await prisma.account.deleteMany();
    await prisma.verificationToken.deleteMany();
    await prisma.user.deleteMany();

    console.log('✓ Cleaned existing data');

    // Create demo users
    const demoUser = await prisma.user.create({
        data: {
            id: 'demo-user-001',
            name: 'Yusuf İpek',
            email: 'yusuf@openframe.dev',
            image: 'https://avatars.githubusercontent.com/u/12345678',
        },
    });

    const collaborator = await prisma.user.create({
        data: {
            id: 'demo-user-002',
            name: 'Ahmet Editör',
            email: 'ahmet@example.com',
            image: 'https://avatars.githubusercontent.com/u/87654321',
        },
    });

    const reviewer = await prisma.user.create({
        data: {
            id: 'demo-user-003',
            name: 'Elif Reviewer',
            email: 'elif@example.com',
        },
    });

    console.log('✓ Created 3 demo users');

    // Create projects
    const techProject = await prisma.project.create({
        data: {
            name: 'Tech Review Series',
            description: 'Weekly tech reviews and tutorials for the YouTube channel. Each video goes through multiple review cycles.',
            slug: 'tech-review-series',
            visibility: ProjectVisibility.PRIVATE,
            ownerId: demoUser.id,
            members: {
                create: [
                    { userId: collaborator.id, role: ProjectMemberRole.EDITOR },
                    { userId: reviewer.id, role: ProjectMemberRole.VIEWER },
                ],
            },
        },
    });

    const tutorialProject = await prisma.project.create({
        data: {
            name: 'Programming Tutorials',
            description: 'In-depth programming tutorials covering modern web development.',
            slug: 'programming-tutorials',
            visibility: ProjectVisibility.INVITE,
            ownerId: demoUser.id,
        },
    });

    const clientProject = await prisma.project.create({
        data: {
            name: 'Client: XYZ Corp Promo',
            description: 'Promotional video for XYZ Corporation product launch.',
            slug: 'xyz-corp-promo',
            visibility: ProjectVisibility.PRIVATE,
            ownerId: collaborator.id,
            members: {
                create: [{ userId: demoUser.id, role: ProjectMemberRole.ADMIN }],
            },
        },
    });

    console.log('✓ Created 3 projects');

    // Create videos with versions for Tech Review project
    const techReviewVideo = await prisma.video.create({
        data: {
            title: 'M4 MacBook Pro Review',
            description: 'Complete review of the new M4 MacBook Pro lineup.',
            position: 0,
            projectId: techProject.id,
            versions: {
                create: [
                    {
                        versionNumber: 1,
                        versionLabel: 'First Draft',
                        providerId: 'youtube',
                        videoId: 'dQw4w9WgXcQ', // Placeholder
                        originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        title: 'M4 MacBook Pro - First Look',
                        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
                        duration: 1245,
                        isActive: false,
                    },
                    {
                        versionNumber: 2,
                        versionLabel: 'Updated Intro',
                        providerId: 'youtube',
                        videoId: 'L_jWHffIx5E', // Placeholder
                        originalUrl: 'https://www.youtube.com/watch?v=L_jWHffIx5E',
                        title: 'M4 MacBook Pro Review - V2',
                        thumbnailUrl: 'https://img.youtube.com/vi/L_jWHffIx5E/maxresdefault.jpg',
                        duration: 1312,
                        isActive: true,
                    },
                ],
            },
        },
    });

    const aiToolsVideo = await prisma.video.create({
        data: {
            title: 'Best AI Tools for Developers 2025',
            description: 'A curated list of AI tools that actually boost productivity.',
            position: 1,
            projectId: techProject.id,
            versions: {
                create: [
                    {
                        versionNumber: 1,
                        versionLabel: 'Initial Cut',
                        providerId: 'youtube',
                        videoId: 'jNQXAC9IVRw',
                        originalUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
                        title: 'AI Tools for Devs',
                        thumbnailUrl: 'https://img.youtube.com/vi/jNQXAC9IVRw/maxresdefault.jpg',
                        duration: 892,
                        isActive: true,
                    },
                ],
            },
        },
    });

    // Tutorial video
    const reactVideo = await prisma.video.create({
        data: {
            title: 'React Server Components Deep Dive',
            description: 'Understanding RSC from first principles.',
            position: 0,
            projectId: tutorialProject.id,
            versions: {
                create: [
                    {
                        versionNumber: 1,
                        providerId: 'youtube',
                        videoId: 'y8AwLxn42HU',
                        originalUrl: 'https://www.youtube.com/watch?v=y8AwLxn42HU',
                        title: 'React Server Components',
                        thumbnailUrl: 'https://img.youtube.com/vi/y8AwLxn42HU/maxresdefault.jpg',
                        duration: 2156,
                        isActive: true,
                    },
                ],
            },
        },
    });

    console.log('✓ Created 3 videos with 4 versions total');

    // Get version IDs for comments
    const macbookVersions = await prisma.videoVersion.findMany({
        where: { videoParentId: techReviewVideo.id },
        orderBy: { versionNumber: 'desc' },
    });

    const activeVersion = macbookVersions[0]; // V2

    // Create comments (some threaded)
    const comment1 = await prisma.comment.create({
        data: {
            content: 'The intro is too long. Can we cut it down to 15 seconds max?',
            timestamp: 0,
            timestampEnd: 32,
            authorId: collaborator.id,
            versionId: activeVersion.id,
        },
    });

    await prisma.comment.create({
        data: {
            content: 'Agreed. I\'ll trim the first section and jump straight to the unboxing.',
            timestamp: 0,
            parentId: comment1.id,
            authorId: demoUser.id,
            versionId: activeVersion.id,
        },
    });

    await prisma.comment.create({
        data: {
            content: 'Great B-roll here! Maybe add some slow-mo for the product shots?',
            timestamp: 145.5,
            authorId: reviewer.id,
            versionId: activeVersion.id,
        },
    });

    await prisma.comment.create({
        data: {
            content: 'Audio levels drop significantly here. Check the lavalier mic.',
            timestamp: 423,
            authorId: collaborator.id,
            versionId: activeVersion.id,
            isResolved: true,
            resolvedAt: new Date(),
        },
    });

    await prisma.comment.create({
        data: {
            content: 'Can you add a sponsor segment transition here?',
            timestamp: 612,
            timestampEnd: 615,
            authorId: demoUser.id,
            versionId: activeVersion.id,
        },
    });

    // Guest comment
    await prisma.comment.create({
        data: {
            content: 'Love the editing style! When will this be published?',
            timestamp: 800,
            guestName: 'Client Viewer',
            guestEmail: 'client@company.com',
            versionId: activeVersion.id,
        },
    });

    console.log('✓ Created 6 comments (including threaded replies and guest comment)');

    // Create share link
    await prisma.shareLink.create({
        data: {
            token: 'review-abc123xyz',
            projectId: techProject.id,
            permission: SharePermission.COMMENT,
            allowGuests: true,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
    });

    console.log('✓ Created share link');

    console.log('\n✅ Seeding complete!\n');
    console.log('Demo accounts:');
    console.log('  - yusuf@openframe.dev (Owner)');
    console.log('  - ahmet@example.com (Editor)');
    console.log('  - elif@example.com (Viewer)');
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
