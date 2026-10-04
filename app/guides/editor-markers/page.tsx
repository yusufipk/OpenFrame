import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Video } from 'lucide-react';
import { DavinciResolveIcon, PremiereProIcon } from '@/components/video-page/editor-icons';

export const metadata: Metadata = {
  title: 'Comments as timeline markers in Premiere Pro and DaVinci Resolve | OpenFrame',
  description:
    'Bring OpenFrame review comments onto your Premiere Pro or DaVinci Resolve timeline as colored markers.',
};

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="space-y-3">{children}</div>
    </li>
  );
}

// Screenshots live in public/guides/editor-markers: Premiere 26.0 on Windows, Resolve Studio 20 on Linux.
function Shot({
  name,
  alt,
  width,
  height,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
}) {
  return (
    <Image
      src={`/guides/editor-markers/${name}.webp`}
      alt={alt}
      width={width}
      height={height}
      className="h-auto rounded-md border border-border"
      style={{ maxWidth: `min(100%, ${width}px)` }}
    />
  );
}

function Path({ children }: { children: ReactNode }) {
  return (
    <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
      {children}
    </code>
  );
}

export default function EditorMarkersGuidePage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[900px] items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
          >
            <Video className="h-4 w-4 text-primary" />
            OpenFrame
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-semibold tracking-tight mb-3">
          Comments as markers on your timeline
        </h1>
        <p className="text-sm text-muted-foreground mb-10 max-w-2xl">
          Bring a video&apos;s review comments into Premiere Pro or DaVinci Resolve as colored
          markers, each at the moment it was made, with the replies inside. After the next round of
          feedback, run it again: the markers are updated and the ones you added yourself stay.
        </p>

        <div className="space-y-12 text-sm leading-relaxed text-foreground/80">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Before you start</h2>
            <p>
              Open the video in OpenFrame, click the download icon above the comments and choose{' '}
              <strong className="text-foreground">Premiere Pro: add to timeline</strong> or{' '}
              <strong className="text-foreground">DaVinci Resolve: add to timeline</strong>. The
              window that opens has everything you need: the download, the video&apos;s link and a
              button that creates a token. A token is a key that lets the plugin read your projects
              and comments; it can&apos;t change anything.
            </p>
          </section>

          <section id="premiere" className="space-y-4 scroll-mt-8">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <PremiereProIcon className="h-7 w-7" />
              Premiere Pro
            </h2>
            <p>Works with Premiere Pro 25.6 or later, installed through Creative Cloud.</p>
            <ol className="space-y-8">
              <Step title="1. Install the panel">
                <p>
                  <a
                    href="/api/integrations/premiere-panel"
                    download
                    className="underline underline-offset-4"
                  >
                    Download the panel
                  </a>{' '}
                  and double-click the file. Creative Cloud asks whether to install it; choose{' '}
                  <strong>Install</strong>.
                </p>
                <Shot
                  name="premiere-install-confirm"
                  alt="Creative Cloud asking to install the plugin"
                  width={545}
                  height={355}
                />
                <p>Then choose OK.</p>
                <Shot
                  name="premiere-install-permissions"
                  alt="Creative Cloud asking for confirmation before installing"
                  width={880}
                  height={485}
                />
                <Shot
                  name="premiere-installed"
                  alt="Creative Cloud showing OpenFrame Comments as installed"
                  width={1305}
                  height={1010}
                />
              </Step>

              <Step title="2. Open the panel">
                <p>
                  In Premiere, choose <strong>Window → UXP Plugins → OpenFrame Comments</strong>.
                  You can dock it next to your other panels.
                </p>
                <Shot
                  name="premiere-open-panel"
                  alt="Premiere's Window menu with UXP Plugins and OpenFrame Comments"
                  width={655}
                  height={220}
                />
                <Shot
                  name="premiere-panel-empty"
                  alt="The OpenFrame Comments panel"
                  width={440}
                  height={763}
                />
              </Step>

              <Step title="3. Paste the link and the token">
                <p>
                  Paste the video&apos;s link and the token, then choose{' '}
                  <strong>Load versions</strong> and pick the version you are cutting. You only
                  paste the token once; the panel remembers it.
                </p>
                <Shot
                  name="premiere-panel-versions"
                  alt="The panel with a video link and token, and a version picked"
                  width={335}
                  height={585}
                />
              </Step>

              <Step title="4. Add the comments">
                <p>
                  With your sequence open, choose{' '}
                  <strong>Add comments to the active sequence</strong>. Resolved comments are left
                  out unless you tick <em>Include resolved comments</em>.
                </p>
                <Shot
                  name="premiere-synced-timeline"
                  alt="Colored comment markers on the Premiere timeline"
                  width={1545}
                  height={940}
                />
                <p>
                  <strong>Window → Markers</strong> lists every comment with its color and replies.
                  Keep the last line of each marker&apos;s comment as it is; the panel uses it to
                  update the marker next time.
                </p>
                <Shot
                  name="premiere-markers-panel"
                  alt="Premiere's Markers panel listing the comments with their colors"
                  width={1600}
                  height={1059}
                />
                <Shot
                  name="premiere-marker-detail"
                  alt="A marker opened in Premiere, with the comment and its reply"
                  width={1465}
                  height={1190}
                />
              </Step>

              <Step title="5. After new feedback">
                <p>
                  Choose the same button again. The markers from last time are replaced with the
                  current comments, so comments resolved since then disappear from the timeline.
                </p>
                <Shot
                  name="premiere-resync"
                  alt="The panel after updating the markers"
                  width={454}
                  height={749}
                />
                <p>
                  Changed your mind? Edit → Undo takes it back in a few steps: two for the first
                  time (colors, then markers), three after that.
                </p>
              </Step>
            </ol>
          </section>

          <section id="resolve" className="space-y-4 scroll-mt-8">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <DavinciResolveIcon className="h-7 w-7" />
              DaVinci Resolve
            </h2>
            <ol className="space-y-8">
              <Step title="1. Install the script">
                <p>
                  <a
                    href="/api/integrations/resolve-script"
                    download
                    className="underline underline-offset-4"
                  >
                    Download the script
                  </a>{' '}
                  and move it into this folder (create the <Path>Utility</Path> folder if it is
                  missing), then restart Resolve:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Windows:{' '}
                    <Path>
                      %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility
                    </Path>
                  </li>
                  <li>
                    Mac:{' '}
                    <Path>
                      ~/Library/Application Support/Blackmagic Design/DaVinci
                      Resolve/Fusion/Scripts/Utility
                    </Path>
                  </li>
                  <li>
                    Linux: <Path>~/.local/share/DaVinciResolve/Fusion/Scripts/Utility</Path>
                  </li>
                </ul>
              </Step>

              <Step title="2. Open the script">
                <p>
                  With your timeline open, choose{' '}
                  <strong>Workspace → Scripts → OpenFrame Comments</strong>.
                </p>
                <Shot
                  name="resolve-open-script"
                  alt="Resolve's Workspace menu with Scripts and OpenFrame Comments"
                  width={320}
                  height={545}
                />
                <Shot
                  name="resolve-window-empty"
                  alt="The OpenFrame Comments window in Resolve"
                  width={673}
                  height={623}
                />
              </Step>

              <Step title="3. Paste the link and the token">
                <p>
                  Paste the video&apos;s link and the token, choose <strong>Load versions</strong>{' '}
                  and pick the version. The script remembers both for next time.
                </p>
                <Shot
                  name="resolve-window-versions"
                  alt="The script with a video link and token, and a version picked"
                  width={673}
                  height={623}
                />
              </Step>

              <Step title="4. Add the comments">
                <p>
                  Choose <strong>Add comments to the current timeline</strong>. Resolved comments
                  are left out unless you tick <em>Include resolved comments</em>.
                </p>
                <Shot
                  name="resolve-synced-timeline"
                  alt="Colored comment markers on the Resolve timeline"
                  width={1600}
                  height={401}
                />
                <p>
                  Double-click a marker to read the comment and its replies. Resolve has no orange
                  markers, so orange tags show as yellow.
                </p>
                <Shot
                  name="resolve-marker-detail"
                  alt="A marker opened in Resolve, with the comment and its reply"
                  width={1431}
                  height={752}
                />
              </Step>

              <Step title="5. After new feedback">
                <p>
                  Choose the same button again and the markers are replaced with the current
                  comments. If one of your own markers sits on the exact frame of a comment, Resolve
                  keeps yours and the script tells you how many comments it skipped.
                </p>
                <Shot
                  name="resolve-resync"
                  alt="The script after updating the markers"
                  width={683}
                  height={660}
                />
              </Step>
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Good to know</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Marker colors follow the comment&apos;s tag. Comments without a tag are cyan,
                resolved ones green.
              </li>
              <li>
                Comments made at the same moment share one marker; its name shows how many more
                there are.
              </li>
              <li>Works with timelines at 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 and 60 fps.</li>
              <li>Lost a computer? Remove its token in OpenFrame under Settings → API Tokens.</li>
              <li>
                Prefer files? The same menu also downloads a Resolve EDL or a Premiere XML to import
                by hand.
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
