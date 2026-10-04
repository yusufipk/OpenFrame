import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Video } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Comments as timeline markers in Premiere Pro and DaVinci Resolve | OpenFrame',
  description:
    'Install the OpenFrame panel for Premiere Pro or the script for DaVinci Resolve and bring review comments onto your timeline as colored markers.',
};

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="space-y-2">{children}</div>
    </li>
  );
}

// Screenshots live in public/guides/editor-markers, taken in Premiere 26.0 on Windows.
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
          The OpenFrame panel for Premiere Pro and the script for DaVinci Resolve put a video&apos;s
          review comments straight onto the timeline you have open, as colored markers at the right
          frames, with the replies in each marker&apos;s note. Run them again after the next round
          of feedback: they replace the markers they wrote before and leave yours alone.
        </p>

        <div className="space-y-12 text-sm leading-relaxed text-foreground/80">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">What you need</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>An OpenFrame account with access to the video.</li>
              <li>
                An API token with the <strong className="text-foreground">Read</strong> and{' '}
                <strong className="text-foreground">Read comments</strong> permissions. The quickest
                way is the <em>Create a read-only token</em> button in the dialog on the video page
                (comments menu → <em>Premiere Pro: add to timeline</em> or{' '}
                <em>DaVinci Resolve: add to timeline</em>). You can also make one in Settings → API
                Tokens.
              </li>
              <li>
                The video&apos;s link: the address of its page in OpenFrame, which the same dialog
                copies for you.
              </li>
            </ul>
          </section>

          <section id="premiere" className="space-y-4 scroll-mt-8">
            <h2 className="text-xl font-semibold text-foreground">Premiere Pro</h2>
            <p>Needs Premiere Pro 25.6 or later and the Creative Cloud desktop app.</p>
            <ol className="space-y-6">
              <Step title="1. Install the panel">
                <p>
                  <a
                    href="/api/integrations/premiere-panel"
                    download
                    className="underline underline-offset-4"
                  >
                    Download the panel
                  </a>{' '}
                  (<Path>openframe-comments.ccx</Path>) and double-click it. Creative Cloud opens
                  and warns that the plugin is not from the Adobe Marketplace; choose Install.
                </p>
                <Shot
                  name="premiere-install-confirm"
                  alt="Creative Cloud asking to install a non-marketplace plugin"
                  width={545}
                  height={355}
                />
                <p>It then lists what a plugin may do; choose OK.</p>
                <Shot
                  name="premiere-install-permissions"
                  alt="Creative Cloud listing the plugin's permissions before installing it"
                  width={880}
                  height={485}
                />
                <Shot
                  name="premiere-installed"
                  alt="Creative Cloud showing OpenFrame Comments as installed for Premiere"
                  width={1305}
                  height={1010}
                />
                <p>
                  If Creative Cloud says no compatible app is installed, Premiere Pro is missing
                  from Creative Cloud or older than 25.6.
                </p>
              </Step>
              <Step title="2. Open it">
                <p>
                  In Premiere, choose <strong>Window → UXP Plugins → OpenFrame Comments</strong>.
                  Dock it wherever you like; it remembers the last video link.
                </p>
                <Shot
                  name="premiere-open-panel"
                  alt="Premiere's Window menu with UXP Plugins and OpenFrame Comments"
                  width={655}
                  height={220}
                />
                <Shot
                  name="premiere-panel-empty"
                  alt="The empty OpenFrame Comments panel"
                  width={440}
                  height={763}
                />
              </Step>
              <Step title="3. Connect it">
                <p>
                  Paste the video link, click outside the box (the panel shows which server it will
                  talk to), paste the token and choose <strong>Load versions</strong>. The token is
                  saved for that server only and filled in again next time.
                </p>
                <Shot
                  name="premiere-panel-versions"
                  alt="The panel with a video link, its server, a token and the versions loaded"
                  width={335}
                  height={585}
                />
              </Step>
              <Step title="4. Add the comments">
                <p>
                  Open the sequence you are editing, pick the version and choose{' '}
                  <strong>Add comments to the active sequence</strong>. The panel reads the
                  sequence&apos;s frame rate and start timecode by itself. Leave{' '}
                  <em>Include resolved comments</em> off to keep finished notes off the timeline.
                </p>
                <Shot
                  name="premiere-synced-timeline"
                  alt="Colored comment markers on the Premiere timeline after a sync"
                  width={1545}
                  height={940}
                />
                <p>
                  Window → Markers lists them with their colors, times and the full thread. Each
                  marker&apos;s comments end with an <Path>[OpenFrame …]</Path> line: that is how
                  the panel recognizes its own markers next time, so leave it in.
                </p>
                <Shot
                  name="premiere-markers-panel"
                  alt="Premiere's Markers panel listing the synced comments with their colors"
                  width={1600}
                  height={1059}
                />
                <Shot
                  name="premiere-marker-detail"
                  alt="A marker opened in Premiere, with the comment and its reply"
                  width={1465}
                  height={1190}
                />
                <p>
                  After new feedback, choose the same button again. The panel replaces what it added
                  last time and says so.
                </p>
                <Shot
                  name="premiere-resync"
                  alt="The panel after a second sync, replacing the markers from the last one"
                  width={454}
                  height={749}
                />
                <p>
                  Each sync can be undone with Edit → Undo: twice for the first one (colors, then
                  markers), three times for a later one.
                </p>
              </Step>
            </ol>
          </section>

          <section id="resolve" className="space-y-4 scroll-mt-8">
            <h2 className="text-xl font-semibold text-foreground">DaVinci Resolve</h2>
            <p>
              Runs inside Resolve from the Workspace menu, so nothing else needs installing; it uses
              curl, which ships with Windows 10 and later, macOS and Linux.
            </p>
            <ol className="space-y-6">
              <Step title="1. Install the script">
                <p>
                  <a
                    href="/api/integrations/resolve-script"
                    download
                    className="underline underline-offset-4"
                  >
                    Download the script
                  </a>{' '}
                  (<Path>OpenFrame Comments.lua</Path>) and move it into Resolve&apos;s scripts
                  folder, creating the <Path>Utility</Path> folder if it is not there:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Windows:{' '}
                    <Path>
                      %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility
                    </Path>
                  </li>
                  <li>
                    macOS:{' '}
                    <Path>
                      ~/Library/Application Support/Blackmagic Design/DaVinci
                      Resolve/Fusion/Scripts/Utility
                    </Path>
                  </li>
                  <li>
                    Linux: <Path>~/.local/share/DaVinciResolve/Fusion/Scripts/Utility</Path>
                  </li>
                </ul>
                <p>Restart Resolve.</p>
              </Step>
              <Step title="2. Open it">
                <p>
                  With your timeline open, choose{' '}
                  <strong>Workspace → Scripts → OpenFrame Comments</strong>.
                </p>
              </Step>
              <Step title="3. Connect it and add the comments">
                <p>
                  Paste the video link and the token, choose <strong>Load versions</strong>, pick
                  the version and choose <strong>Add comments to the current timeline</strong>. The
                  script reads the timeline&apos;s frame rate by itself and keeps the token for that
                  server in a file in your user folder.
                </p>
                <p>
                  A Resolve marker owns its frame: if one of your own markers sits exactly where a
                  comment lands, that comment is skipped and the script says how many were.
                </p>
              </Step>
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Other editors and files</h2>
            <p>
              The same comments menu also downloads a Resolve EDL, a Premiere XML or a Final Cut Pro
              FCPXML file. Those need the timeline&apos;s frame rate and start timecode entered by
              hand, and Premiere and Final Cut import them as a separate sequence or project rather
              than onto your own.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Good to know</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Supported frame rates: 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 and 60, drop-frame
                or not.
              </li>
              <li>
                Comments on the same frame share one marker; its name shows how many more there are.
              </li>
              <li>
                Marker colors follow the comment&apos;s tag; untagged comments are cyan and resolved
                ones green, as in the OpenFrame player.
              </li>
              <li>
                The token only reads. Revoke it in Settings → API Tokens if a machine is lost.
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
