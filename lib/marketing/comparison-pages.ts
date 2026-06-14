import type {
  ComparisonPageDefinition,
  FeatureRow,
  PricingRow,
} from '@/lib/marketing/comparison-types';
import { competitorProfiles, openFrameProfile } from '@/lib/marketing/comparison-sources';

const commonOpenFrameWins = [
  '$10/month flat hosted pricing — no per-member or per-guest fees',
  '7-day free trial, then unlimited collaborators on one plan',
  'Self-host for free with Docker when you need full data control',
  'Voice notes and drawn annotations on the timeline',
  'Formal approval requests with per-reviewer status',
  'PDF and CSV exports for client handoff',
  'Unlimited YouTube imports on the hosted plan',
];

const commonFreelancerPain = {
  painTitle: 'Feedback should not live in five different apps',
  painNarrative:
    'Freelancers lose hours when clients send vague notes in email, WhatsApp, and screenshots. You end up guessing timecodes, re-uploading cuts, and chasing approvals that never feel final.',
  painBullets: [
    'Comments scattered across email threads and chat apps',
    'Vague notes like "fix the intro around 1:12"',
    'No clear record of which version was approved',
    'Clients stall when the review tool feels complicated',
  ],
};

const commonClientApprovalPain = {
  painTitle: 'Clients do not want another login',
  painNarrative:
    'Approval delays usually start before the first note. If a client has to create an account, install software, or decode a complex interface, the review slows down before it starts.',
  painBullets: [
    'Clients abandon review flows that require signup',
    'Stakeholders comment on the wrong version',
    'There is no single place to see approval status',
    'Handoff reports get rebuilt manually after the fact',
  ],
};

const competitorFeatureRows: Record<string, FeatureRow[]> = {
  'frame-io': [
    { label: 'Timestamped comments', openframe: 'yes', competitor: 'yes' },
    { label: 'Voice notes on timeline', openframe: 'yes', competitor: 'no' },
    { label: 'Drawn frame annotations', openframe: 'yes', competitor: 'yes' },
    { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
    { label: 'Approval workflow', openframe: 'yes', competitor: 'yes' },
    { label: 'Guest review without account', openframe: 'yes', competitor: 'yes' },
    { label: 'Comment export', openframe: 'yes', competitor: 'yes' },
    { label: 'Self-hosting option', openframe: 'yes', competitor: 'no' },
    {
      label: 'Flat pricing without per-member fees',
      openframe: 'yes',
      competitor: 'no',
      note: 'Frame.io guests review free via links, but team seats are billed per member.',
    },
  ],
  wipster: [
    { label: 'Timestamped comments', openframe: 'yes', competitor: 'yes' },
    { label: 'Voice notes on timeline', openframe: 'yes', competitor: 'no' },
    { label: 'Drawn frame annotations', openframe: 'yes', competitor: 'yes' },
    { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
    { label: 'Approval workflow', openframe: 'yes', competitor: 'yes' },
    { label: 'Guest review without account', openframe: 'yes', competitor: 'yes' },
    { label: 'Comment export', openframe: 'yes', competitor: 'partial' },
    { label: 'Self-hosting option', openframe: 'yes', competitor: 'no' },
    {
      label: 'Flat pricing without per-member fees',
      openframe: 'yes',
      competitor: 'partial',
      note: 'Wipster reviewers are free, but Team plans bill per user seat.',
    },
  ],
  'dropbox-replay': [
    { label: 'Timestamped comments', openframe: 'yes', competitor: 'yes' },
    { label: 'Voice notes on timeline', openframe: 'yes', competitor: 'no' },
    { label: 'Drawn frame annotations', openframe: 'yes', competitor: 'yes' },
    { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
    { label: 'Approval workflow', openframe: 'yes', competitor: 'yes' },
    { label: 'Guest review without account', openframe: 'yes', competitor: 'yes' },
    { label: 'Comment export', openframe: 'yes', competitor: 'partial' },
    { label: 'Self-hosting option', openframe: 'yes', competitor: 'no' },
    {
      label: 'Flat pricing without per-member fees',
      openframe: 'yes',
      competitor: 'no',
      note: 'Replay Add-On is priced per user on top of a Dropbox plan.',
    },
  ],
  flask: [
    { label: 'Voice feedback', openframe: 'yes', competitor: 'yes' },
    { label: 'Auto-structured spoken notes', openframe: 'partial', competitor: 'yes' },
    { label: 'Formal approval workflow', openframe: 'yes', competitor: 'partial' },
    { label: 'Guest review links', openframe: 'yes', competitor: 'yes' },
    { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
    { label: 'Self-hosting', openframe: 'yes', competitor: 'no' },
    {
      label: 'Flat pricing without per-member fees',
      openframe: 'yes',
      competitor: 'partial',
      note: 'Flask charges $0 per guest on Pro, but team seats are $15/user/month billed yearly.',
    },
    { label: 'Published pricing', openframe: 'yes', competitor: 'yes' },
    { label: 'PDF/CSV export', openframe: 'yes', competitor: 'partial' },
  ],
  'vimeo-review': [
    { label: 'Timestamped comments', openframe: 'yes', competitor: 'yes' },
    { label: 'Voice notes on timeline', openframe: 'yes', competitor: 'no' },
    { label: 'Drawn frame annotations', openframe: 'yes', competitor: 'partial' },
    { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
    { label: 'Approval workflow', openframe: 'yes', competitor: 'yes' },
    { label: 'Guest review without account', openframe: 'yes', competitor: 'yes' },
    { label: 'Comment export', openframe: 'yes', competitor: 'no' },
    { label: 'Self-hosting option', openframe: 'yes', competitor: 'no' },
    {
      label: 'Flat pricing without per-member fees',
      openframe: 'yes',
      competitor: 'partial',
      note: 'Vimeo review guests are free via links, but team hosting plans scale by seat.',
    },
  ],
};

function defaultFeatureRows(competitorId: string): FeatureRow[] {
  return competitorFeatureRows[competitorId] ?? [];
}

function competitorPricingRows(competitorId: string): PricingRow[] {
  const profile = competitorProfiles[competitorId];
  if (!profile) return [];

  return [
    {
      label: 'Per-member or guest fees',
      openframe: '$10/mo flat — no per-seat or guest charges',
      competitor: profile.pricingSummary,
    },
    {
      label: 'External reviewer access',
      openframe: 'Share link, no account required',
      competitor: profile.reviewerAccess,
    },
    {
      label: 'Self-hosted option',
      openframe: 'Free (Docker)',
      competitor: profile.selfHosted ? 'Yes' : 'No',
    },
    {
      label: 'Trial',
      openframe: '7-day free trial on hosted',
      competitor: profile.pricingNotes[0] ?? 'See vendor site',
    },
  ];
}

function competitorPage(
  slug: string,
  competitorId: string,
  overrides: Partial<ComparisonPageDefinition> &
    Pick<
      ComparisonPageDefinition,
      | 'title'
      | 'metaDescription'
      | 'keywords'
      | 'headline'
      | 'subheadline'
      | 'solutionTitle'
      | 'solutionNarrative'
      | 'openframeWins'
      | 'competitorWins'
      | 'faq'
    >
): ComparisonPageDefinition {
  const profile = competitorProfiles[competitorId];

  return {
    slug,
    competitorId,
    pageType: 'competitor',
    eyebrow: `${profile.name} alternative`,
    painTitle: commonFreelancerPain.painTitle,
    painNarrative: commonFreelancerPain.painNarrative,
    painBullets: commonFreelancerPain.painBullets,
    bestForOpenFrame: openFrameProfile.bestFor,
    bestForCompetitor: profile.bestFor,
    featureRows: defaultFeatureRows(competitorId),
    pricingRows: competitorPricingRows(competitorId),
    pricingFootnote: 'Pricing and features change. Verify current plans on each vendor website.',
    visualVariant: 'landing-dashboard',
    relatedSlugs: [
      'frame-io-alternative',
      'video-review-tool-for-freelancers',
      'client-video-approval-tool',
    ],
    ...overrides,
  };
}

export const comparisonPages: ComparisonPageDefinition[] = [
  competitorPage('frame-io-alternative', 'frame-io', {
    title: 'Frame.io Alternative for Small Teams',
    metaDescription:
      'Compare OpenFrame vs Frame.io for freelancers and small teams. Get timestamped review, approvals, guest links, and self-hosting without per-seat enterprise pricing.',
    keywords: ['frame.io alternative', 'frame io alternative', 'open source frame.io alternative'],
    headline: 'Frame.io power without the enterprise bill',
    subheadline:
      'Frame.io is the industry standard for large post teams. OpenFrame gives freelancers and small studios the review workflow they actually need: one link, one timeline, clear approvals, and optional self-hosting.',
    solutionTitle: 'Built for small teams, not studio overhead',
    solutionNarrative:
      'OpenFrame keeps the parts that save approval time—timestamped comments, voice notes, annotations, version compare, and sign-off tracking—without tying you to per-member pricing or a full creative-ops platform.',
    openframeWins: [...commonOpenFrameWins, 'Fair-source codebase you can inspect and self-host'],
    competitorWins: [
      'Deep Adobe Premiere, Final Cut, and enterprise media workflows',
      'Camera to Cloud, DRM, forensic watermarking, and SSO at enterprise scale',
      'Mature metadata, collections, and multi-workspace operations',
    ],
    faq: [
      {
        question: 'Do clients need a Frame.io account?',
        answer:
          'Not for share-link review. Frame.io supports external reviewers via links without accounts, but internal project management still uses paid member seats.',
      },
      {
        question: 'Why switch from Frame.io to OpenFrame?',
        answer:
          'If you are a freelancer or small team paying for features you never touch, OpenFrame offers a simpler approval workflow, lower hosted pricing, and a free self-hosted path.',
      },
      {
        question: 'Can OpenFrame replace Frame.io for enterprise MAM?',
        answer:
          'Not today. OpenFrame is focused on review, versioning, and approvals—not large-scale media asset management or Adobe enterprise controls.',
      },
    ],
    visualVariant: 'landing-compare',
    relatedSlugs: [
      'self-hosted-frame-io-alternative',
      'wipster-alternative',
      'client-video-approval-tool',
    ],
  }),
  {
    slug: 'self-hosted-frame-io-alternative',
    competitorId: 'frame-io',
    pageType: 'use-case',
    title: 'Self-Hosted Frame.io Alternative',
    metaDescription:
      'OpenFrame is a self-hosted Frame.io alternative with timestamped review, approvals, guest links, and Docker deployment for teams that need full data control.',
    keywords: [
      'self hosted frame.io alternative',
      'self-hosted video review',
      'open source video review',
    ],
    eyebrow: 'Self-hosted review',
    headline: 'Keep client footage on your infrastructure',
    subheadline:
      'If Frame.io’s cloud-only model is the blocker, OpenFrame gives you the same core review loop—comments, versions, approvals, and share links—on hardware you control.',
    painTitle: 'Cloud review tools are not always a fit',
    painNarrative:
      'Some teams cannot upload client masters to US-hosted SaaS by policy, budget, or principle. They still need timestamped review and approvals—not a return to email chaos.',
    painBullets: [
      'Client contracts restrict third-party cloud storage',
      'Per-seat SaaS costs add up across occasional collaborators',
      'You want auditability over where footage lives',
      'You need a review tool that works air-gapped or on-prem',
    ],
    solutionTitle: 'Self-host without giving up the workflow',
    solutionNarrative:
      'OpenFrame ships with Docker Compose, PostgreSQL, and S3-compatible storage. Optionally wire up your own Bunny CDN instance for streaming. Run on your server, keep projects private by default, and still send clients a simple browser review link.',
    bestForOpenFrame: [
      'Teams with Docker ops capacity',
      'Privacy-sensitive client work',
      'Studios comparing Frame.io to open/fair-source options',
    ],
    bestForCompetitor: [
      'Teams needing Adobe enterprise integrations out of the box',
      'Studios without any infrastructure maintenance capacity',
      'Large distributed teams needing vendor-managed scale',
    ],
    openframeWins: [
      'Free self-hosted deployment with full review features',
      'Docker Compose setup with PostgreSQL and MinIO',
      'Optional Bunny CDN integration for self-hosted streaming',
      'Optional hosted cloud if you want zero ops later',
      'Guest share links and approval workflow included',
    ],
    competitorWins: [
      'Fully managed transcoding and delivery without running your own stack',
      'Enterprise security certifications and Adobe ecosystem depth',
      'No server maintenance required',
    ],
    featureRows: [
      { label: 'Self-hosting', openframe: 'yes', competitor: 'no' },
      { label: 'Docker deployment', openframe: 'yes', competitor: 'no' },
      { label: 'Guest review links', openframe: 'yes', competitor: 'yes' },
      { label: 'Approval workflow', openframe: 'yes', competitor: 'yes' },
      { label: 'Version compare', openframe: 'yes', competitor: 'yes' },
      { label: 'Enterprise DRM / SSO', openframe: 'no', competitor: 'yes' },
      { label: 'Adobe NLE integrations', openframe: 'no', competitor: 'yes' },
      { label: 'Open/fair-source codebase', openframe: 'yes', competitor: 'no' },
    ],
    pricingRows: [
      { label: 'Self-hosted software cost', openframe: 'Free', competitor: 'Not available' },
      {
        label: 'Per-member or guest fees',
        openframe: '$10/mo flat — no per-seat or guest charges',
        competitor: 'From $15/member/mo for team seats',
      },
      {
        label: 'CDN / streaming',
        openframe: 'Optional self-hosted Bunny CDN',
        competitor: 'Vendor-managed CDN',
      },
      { label: 'Data residency', openframe: 'Your servers', competitor: 'Vendor cloud' },
    ],
    pricingFootnote: 'Self-hosting still requires your own compute, storage, and maintenance.',
    faq: [
      {
        question: 'Is OpenFrame really self-hostable?',
        answer:
          'Yes. The repository includes Docker Compose, migrations on boot, and optional S3-compatible storage. You can also use the hosted plan if you do not want to operate infrastructure.',
      },
      {
        question: 'Can I use a CDN with self-hosted OpenFrame?',
        answer:
          'Yes. You can integrate your own Bunny CDN instance for streaming on self-hosted deployments, keeping delivery on infrastructure you control.',
      },
      {
        question: 'Do clients still need accounts on self-hosted OpenFrame?',
        answer:
          'No. Clients can review via share links in the browser without creating an account.',
      },
    ],
    visualVariant: 'landing-dashboard',
    relatedSlugs: [
      'frame-io-alternative',
      'video-review-tool-for-freelancers',
      'client-video-approval-tool',
    ],
  },
  {
    slug: 'video-review-tool-for-freelancers',
    competitorId: null,
    pageType: 'use-case',
    title: 'Video Review Tool for Freelancers',
    metaDescription:
      'OpenFrame is a video review tool for freelancers with timestamped comments, voice notes, guest links, version compare, and affordable hosted or free self-hosted pricing.',
    keywords: [
      'video review tool for freelancers',
      'freelance video review',
      'client video feedback',
    ],
    eyebrow: 'For freelancers',
    headline: 'Stop chasing timecodes. Start shipping cuts.',
    subheadline:
      'You do not need enterprise creative ops to get professional client review. OpenFrame gives freelancers one link, one timeline, and a clear approval state.',
    painTitle: commonFreelancerPain.painTitle,
    painNarrative: commonFreelancerPain.painNarrative,
    painBullets: commonFreelancerPain.painBullets,
    solutionTitle: 'A freelancer-sized review stack',
    solutionNarrative:
      'Upload or import a cut, share a link, collect timestamped feedback with text or voice, compare versions, and export a report when the client signs off.',
    bestForOpenFrame: openFrameProfile.bestFor,
    bestForCompetitor: [
      'Full-time post houses needing Adobe-native enterprise tooling',
      'Teams already standardized on Frame.io or Dropbox',
      'Studios needing storyboard-to-delivery production suites',
    ],
    openframeWins: commonOpenFrameWins,
    competitorWins: [
      'Mature NLE integrations for large facility workflows',
      'Specialized tools for EU-only hosting or voice-first feedback',
      'All-in-one suites if you already pay for Vimeo or Dropbox',
    ],
    featureRows: [
      { label: 'Timestamped comments', openframe: 'yes', competitor: 'Varies' },
      { label: 'Voice notes on timeline', openframe: 'yes', competitor: 'Rare' },
      { label: 'Guest review without account', openframe: 'yes', competitor: 'Varies' },
      { label: 'Approval workflow', openframe: 'yes', competitor: 'Varies' },
      { label: 'Self-hosting option', openframe: 'yes', competitor: 'Rare' },
      {
        label: 'Flat pricing without per-member fees',
        openframe: 'yes',
        competitor: 'Rare',
      },
    ],
    pricingRows: [
      {
        label: 'Per-member or guest fees',
        openframe: '$10/mo flat — no per-seat or guest charges',
        competitor: 'Often per-seat or bundled with hosting',
      },
      { label: 'Self-hosted', openframe: 'Free', competitor: 'Rare' },
      { label: 'Client accounts', openframe: 'Not required', competitor: 'Varies by tool' },
      { label: 'YouTube imports', openframe: 'Unlimited on hosted', competitor: 'Varies' },
    ],
    faq: [
      {
        question: 'What makes a good freelancer video review tool?',
        answer:
          'Clients should review in the browser without friction, every note should land on a timestamp, and you should always know which version is approved.',
      },
      {
        question: 'Can I start free?',
        answer: 'Yes. Use the 7-day hosted trial or self-host for free with Docker.',
      },
      {
        question: 'Is OpenFrame only for video?',
        answer:
          'OpenFrame is video-first: comments, voice notes, annotations, versions, and approvals are built around the timeline.',
      },
    ],
    visualVariant: 'landing-dashboard',
    relatedSlugs: ['client-video-approval-tool', 'frame-io-alternative', 'wipster-alternative'],
  },
  {
    slug: 'client-video-approval-tool',
    competitorId: null,
    pageType: 'use-case',
    title: 'Client Video Approval Tool',
    metaDescription:
      'OpenFrame is a client video approval tool with share links, timestamped feedback, approval requests, and PDF/CSV exports for freelancers and small teams.',
    keywords: ['client video approval tool', 'video approval software', 'client sign off video'],
    eyebrow: 'Client approvals',
    headline: 'Get to “approved” without another login wall',
    subheadline:
      'Clients review in the browser, leave timestamped notes, and approve the exact version you need to ship.',
    painTitle: commonClientApprovalPain.painTitle,
    painNarrative: commonClientApprovalPain.painNarrative,
    painBullets: commonClientApprovalPain.painBullets,
    solutionTitle: 'Approvals that clients actually complete',
    solutionNarrative:
      'Send one link, collect precise feedback on the timeline, request approval from specific reviewers, and keep a record of who signed off on which version.',
    bestForOpenFrame: [
      'Editors and producers who need formal sign-off',
      'Agencies with non-technical clients',
      'Teams that export approval records for delivery',
    ],
    bestForCompetitor: [
      'Marketing orgs needing multi-asset proofing across PDFs and websites',
      'Large teams with compliance-heavy approval chains',
      'Studios standardized on incumbent review platforms',
    ],
    openframeWins: [
      'Approval requests with pending, approved, and rejected states',
      'Guest share links with optional password and expiry',
      'Timestamped comments, voice notes, and annotations',
      'PDF/CSV exports for delivery documentation',
    ],
    competitorWins: [
      'Enterprise proofing suites with reviewer groups and automations',
      'Deep Adobe integrations for facility-scale post',
      'Voice-first feedback tools for spoken review sessions',
    ],
    featureRows: [
      { label: 'Explicit approval states', openframe: 'yes', competitor: 'partial' },
      { label: 'Per-reviewer approval tracking', openframe: 'yes', competitor: 'partial' },
      { label: 'Guest review without account', openframe: 'yes', competitor: 'partial' },
      { label: 'Password-protected share links', openframe: 'yes', competitor: 'partial' },
      { label: 'Export approval history', openframe: 'yes', competitor: 'partial' },
      { label: 'Multi-asset marketing proofing', openframe: 'no', competitor: 'partial' },
    ],
    pricingRows: [
      {
        label: 'Per-member or guest fees',
        openframe: '$10/mo flat — no per-seat or guest charges',
        competitor: 'Varies by platform',
      },
      { label: 'Self-hosted', openframe: 'Free', competitor: 'Rare' },
      {
        label: 'Client seats',
        openframe: 'Free via share links',
        competitor: 'Often free via links',
      },
      { label: 'Export reports', openframe: 'PDF/CSV included', competitor: 'Varies' },
    ],
    faq: [
      {
        question: 'Do clients need an account to approve a video?',
        answer:
          'No. Clients open a share link, enter a name if needed, and can approve from the browser.',
      },
      {
        question: 'Can I see who approved which version?',
        answer: 'Yes. Approval requests track reviewer decisions per version.',
      },
      {
        question: 'Can I send a password-protected review link?',
        answer: 'Yes. Share links support optional password and expiry settings.',
      },
    ],
    visualVariant: 'landing-compare',
    relatedSlugs: [
      'video-review-tool-for-freelancers',
      'frame-io-alternative',
      'wipster-alternative',
    ],
  },
  competitorPage('wipster-alternative', 'wipster', {
    title: 'Wipster Alternative for Video Review',
    metaDescription:
      'Compare OpenFrame vs Wipster for freelancers and small teams. Get guest review links, version compare, approvals, and lower pricing with optional self-hosting.',
    keywords: ['wipster alternative', 'wipster vs openframe', 'video review alternative'],
    headline: 'Wipster-style review without agency-scale pricing',
    subheadline:
      'Wipster is a solid video-first review tool. OpenFrame matches the core approval loop while adding voice notes, exports, and a free self-hosted path.',
    solutionTitle: 'Same review outcome, simpler economics',
    solutionNarrative:
      'If you mainly need clients to comment on timecodes, compare versions, and approve a cut, OpenFrame covers that workflow at a lower monthly cost.',
    openframeWins: [...commonOpenFrameWins, 'Lower hosted entry price for solo operators'],
    competitorWins: [
      'Mature NLE review panels for Premiere and After Effects',
      'Long track record with agencies and universities',
      'Supports audio, PDF, and image review in one place',
    ],
    faq: [
      {
        question: 'Does Wipster charge for reviewers?',
        answer:
          'No. Wipster includes unlimited reviewers. OpenFrame also supports guest review links without client seats.',
      },
      {
        question: 'When is Wipster still the better fit?',
        answer:
          'If you rely heavily on Wipster’s NLE panels and agency workflows already in production.',
      },
      {
        question: 'Does OpenFrame support version compare?',
        answer: 'Yes. You can compare two versions side by side on one timeline.',
      },
    ],
    relatedSlugs: [
      'frame-io-alternative',
      'client-video-approval-tool',
      'dropbox-replay-alternative',
    ],
  }),
  competitorPage('dropbox-replay-alternative', 'dropbox-replay', {
    title: 'Dropbox Replay Alternative',
    metaDescription:
      'Compare OpenFrame vs Dropbox Replay for video review. Get a dedicated approval workflow, guest links, and optional self-hosting without Dropbox plan lock-in.',
    keywords: ['dropbox replay alternative', 'dropbox replay vs', 'video review without dropbox'],
    headline: 'Video review without Dropbox lock-in',
    subheadline:
      'Dropbox Replay is convenient if your files already live in Dropbox. OpenFrame is a focused review platform that does not require a storage suite to function.',
    solutionTitle: 'A review tool, not a storage add-on',
    solutionNarrative:
      'OpenFrame is built around review, versions, and approvals first—so you are not paying for a file-sync platform just to collect timestamped client notes.',
    openframeWins: [
      ...commonOpenFrameWins,
      'No Dropbox plan or Replay Add-On required',
      'Dedicated project and approval model',
    ],
    competitorWins: [
      'Native if your pipeline already lives in Dropbox',
      'NLE integrations tied to Dropbox storage',
      'Large file transfer and archive features via Dropbox',
    ],
    faq: [
      {
        question: 'Is Dropbox Replay free?',
        answer:
          'Replay is included with limits on most plans. Full usage typically requires a paid Dropbox plan and often the Replay Add-On.',
      },
      {
        question: 'Can OpenFrame replace Replay for NLE markers?',
        answer:
          'OpenFrame focuses on browser review, approvals, and exports rather than in-editor marker sync.',
      },
      {
        question: 'Do clients need Dropbox accounts?',
        answer:
          'Not necessarily for all Replay flows, but the product assumes Dropbox storage context. OpenFrame uses standalone share links.',
      },
    ],
    relatedSlugs: [
      'frame-io-alternative',
      'vimeo-review-alternative',
      'video-review-tool-for-freelancers',
    ],
  }),
  competitorPage('vimeo-review-alternative', 'vimeo-review', {
    title: 'Vimeo Review Alternative',
    metaDescription:
      'Compare OpenFrame vs Vimeo Review. Get dedicated approvals, voice notes, exports, and self-hosting without tying review to Vimeo hosting plans.',
    keywords: ['vimeo review alternative', 'vimeo video review alternative'],
    headline: 'Review workflow without Vimeo plan lock-in',
    subheadline:
      'Vimeo Review is convenient when you already host on Vimeo. OpenFrame is a standalone review platform with its own hosted and self-hosted options.',
    solutionTitle: 'Decouple review from distribution',
    solutionNarrative:
      'You should not need a video hosting subscription to run a professional approval loop. OpenFrame works whether your master lives on YouTube, direct upload, or self-hosted storage.',
    openframeWins: [
      ...commonOpenFrameWins,
      'Standalone product—not a hosting bundle',
      'Unlimited YouTube imports on hosted plan',
    ],
    competitorWins: [
      'Built into Vimeo when you already distribute there',
      'Premiere integration and Vimeo player polish',
      'Review links tied to hosted library and version history',
    ],
    faq: [
      {
        question: 'Do Vimeo reviewers need accounts?',
        answer: 'No for review links. Guests can comment after providing name and email.',
      },
      {
        question: 'Can OpenFrame import YouTube videos?',
        answer: 'Yes. Hosted OpenFrame supports unlimited YouTube URL imports.',
      },
      {
        question: 'When is Vimeo Review enough?',
        answer: 'If your team already hosts, delivers, and reviews entirely inside Vimeo.',
      },
    ],
    visualVariant: 'landing-dashboard',
    relatedSlugs: [
      'dropbox-replay-alternative',
      'video-review-tool-for-freelancers',
      'frame-io-alternative',
    ],
  }),
  competitorPage('flask-alternative', 'flask', {
    title: 'Flask Alternative for Video Feedback',
    metaDescription:
      'Compare OpenFrame vs Flask for video feedback. Get structured approvals, guest review links, exports, and self-hosting alongside spoken-note workflows.',
    keywords: ['flask.do alternative', 'flask video feedback alternative'],
    headline: 'Structured approvals beyond spoken feedback',
    subheadline:
      'Flask is compelling for voice-first review. OpenFrame is for teams that also need formal approvals, exports, guest links, and optional self-hosting.',
    solutionTitle: 'Capture feedback and close the approval loop',
    solutionNarrative:
      'OpenFrame supports voice notes too—but it also tracks approval status per reviewer, compares versions, and exports a handoff record when the cut is cleared.',
    openframeWins: [
      ...commonOpenFrameWins,
      'Formal approval requests and status tracking',
      'Self-host or use managed hosting',
      '$10/mo flat for the whole team — not per seat',
    ],
    competitorWins: [
      'Best-in-class spoken feedback that auto-structures into notes',
      'Free tier with all features (1 asset at a time, no card)',
      'MCP/agent workflow integrations',
      'Premiere export and upmarket production focus',
    ],
    pricingRows: [
      {
        label: 'Team pricing',
        openframe: '$10/mo flat — unlimited members and guests',
        competitor: 'Free (1 asset) · Pro $15/user/mo (yearly) · Enterprise from 15 seats',
      },
      {
        label: 'Per-guest fees',
        openframe: 'None',
        competitor: '$0 per guest on Pro',
      },
      {
        label: 'Self-hosted option',
        openframe: 'Free (Docker)',
        competitor: 'No',
      },
      {
        label: 'Trial',
        openframe: '7-day free trial on hosted',
        competitor: 'Free plan — no card required',
      },
    ],
    faq: [
      {
        question: 'Does OpenFrame support voice notes?',
        answer: 'Yes. Reviewers can leave voice notes anchored to timestamps on the timeline.',
      },
      {
        question: 'How much does Flask cost?',
        answer:
          'Flask offers a free plan (1 asset at a time, no card), Pro at $15/user/month billed yearly with $0 per guest, and custom enterprise pricing from 15 seats.',
      },
      {
        question: 'When is Flask the better fit?',
        answer:
          'When your reviewers primarily talk through notes and you want AI-structured feedback capture.',
      },
      {
        question: 'Can clients approve without an account in OpenFrame?',
        answer: 'Yes. Share links support guest review and approval flows.',
      },
    ],
    visualVariant: 'landing-dashboard',
    relatedSlugs: [
      'client-video-approval-tool',
      'video-review-tool-for-freelancers',
      'frame-io-alternative',
    ],
  }),
];

export const comparisonPageMap = Object.fromEntries(
  comparisonPages.map((page) => [page.slug, page])
) as Record<string, ComparisonPageDefinition>;

export const comparisonSlugs = comparisonPages.map((page) => page.slug);

export const compareFooterLinks = comparisonPages.map((page) => ({
  href: `/${page.slug}`,
  label: page.eyebrow,
}));

export function getComparisonPage(slug: string): ComparisonPageDefinition | undefined {
  return Object.hasOwn(comparisonPageMap, slug) ? comparisonPageMap[slug] : undefined;
}

export function getCompetitorName(page: ComparisonPageDefinition): string | null {
  if (!page.competitorId) return null;
  return competitorProfiles[page.competitorId]?.name ?? null;
}
