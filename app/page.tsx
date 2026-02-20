import Link from 'next/link';
import { Video, MessageSquare, Mic, Share2, ArrowRight, Play, Github, Server, History, Users, Clock, ArrowUpRight, PenTool, Image as ImageIcon, Sparkles, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';

export default async function HomePage() {
  const session = await auth();
  const isLoggedIn = !!session?.user;

  return (
    <div className="min-h-screen bg-background selection:bg-primary/30">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-md sticky top-0 z-50">
        <div className="px-6 lg:px-12 flex h-16 items-center justify-between w-full max-w-7xl mx-auto">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="bg-primary/10 p-2 rounded-xl group-hover:bg-primary/20 transition-colors">
              <Video className="h-5 w-5 text-primary" />
            </div>
            <span className="font-bold text-xl tracking-tight">OpenFrame</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="https://github.com/yusufipk/OpenFrame" target="_blank" className="text-muted-foreground hover:text-foreground transition-colors hidden sm:flex items-center gap-2 text-sm font-medium">
              <Github className="h-4 w-4" />
              Star on GitHub
            </Link>
            {isLoggedIn ? (
              <Button asChild variant="default" className="rounded-full px-6">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" className="hidden sm:inline-flex">
                  <Link href="/login">Sign in</Link>
                </Button>
                <Button asChild className="rounded-full px-6 shadow-lg shadow-primary/20">
                  <Link href="/register">Get Started</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        {/* Hero Section */}
        <section className="relative px-6 pt-10 pb-16 md:pt-10 md:pb-24 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background pointer-events-none" />
          <div className="relative flex flex-col items-center text-center max-w-4xl mx-auto z-10 space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium border border-primary/20">
              <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse"></span>
              Open Source Video Feedback Tool
            </div>
            <h1 className="text-5xl md:text-7xl font-bold tracking-tighter leading-[1.1]">
              Review videos without <br className="hidden md:block" />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary/60">
                losing your mind.
              </span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl leading-relaxed mt-2">
              Paste a YouTube link or upload directly. Get timestamped comments, voice notes, and version control in one beautiful frame. Stop chasing feedback in Slack threads.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto pt-4">
              {isLoggedIn ? (
                <Button asChild size="lg" className="rounded-full h-12 px-8 text-base">
                  <Link href="/dashboard">
                    Go to Dashboard
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
              ) : (
                <Button asChild size="lg" className="rounded-full h-12 px-8 text-base shadow-xl shadow-primary/20">
                  <Link href="/register">
                    Start for free
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline" size="lg" className="rounded-full h-12 px-8 text-base bg-background">
                <Link href="#features">
                  Explore Features
                </Link>
              </Button>
            </div>
          </div>

          {/* Hero Video */}
          <div className="max-w-6xl mx-auto mt-20 relative rounded-2xl border border-border/50 bg-card/50 shadow-2xl overflow-hidden aspect-video flex items-center justify-center group">
            <video
              autoPlay
              muted
              loop
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
            >
              <source src="/hero-demo.mp4" type="video/mp4" />
            </video>
            <div className="absolute inset-0 bg-gradient-to-tr from-primary/5 via-transparent to-transparent opacity-50 pointer-events-none" />
            <div className="relative z-10 flex flex-col items-center gap-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all duration-500">
              <Play className="h-16 w-16" />
              <p className="font-medium text-sm tracking-widest uppercase">Preview</p>
            </div>
          </div>
        </section>

        {/* Feature 1: Visual Left, Text Right */}
        <section id="features" className="px-6 py-24 md:py-32 bg-accent/30 border-y">
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center flex-col-reverse lg:flex-row">
            <div className="order-1 lg:order-1 aspect-square md:aspect-video lg:aspect-square bg-card rounded-3xl border shadow-xl flex items-center justify-center p-8 relative overflow-hidden w-full">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-primary/5 to-transparent" />
              {/* Visual Placeholder for Comments */}
              <div className="flex flex-col gap-4 w-full max-w-md relative z-10">
                <div className="bg-background border rounded-lg p-4 shadow-sm flex gap-4 opacity-80 translate-y-4">
                  <div className="h-8 w-8 rounded-full bg-primary/20 shrink-0" />
                  <div className="space-y-2 w-full">
                    <div className="h-2 w-24 bg-muted rounded" />
                    <div className="h-2 w-full bg-muted rounded" />
                  </div>
                </div>
                <div className="bg-background border-2 border-primary/20 rounded-lg p-4 shadow-md flex gap-4 transform scale-105">
                  <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground">YI</div>
                  <div className="space-y-3 w-full">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-foreground">Yusuf İpek</span>
                        <div className="inline-flex items-center gap-1 bg-primary/10 text-primary px-1.5 py-0.5 rounded text-[10px] font-bold">
                          <Clock className="h-3 w-3" />
                          0:39
                          <ArrowUpRight className="h-2 w-2 ml-0.5" />
                        </div>
                      </div>
                      <Mic className="h-3 w-3 text-primary" />
                    </div>
                    <p className="text-sm font-medium leading-tight">"Let's change the color to red."</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="order-2 lg:order-2 space-y-8 w-full">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <MessageSquare className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-4xl font-bold tracking-tight">Pinpoint exactly what needs fixing.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Stop guessing what "that thing around 2 minutes in" means.
                Drop timestamped comments directly on the timeline. Feeling lazy? Leave a voice note instead.
              </p>
              <ul className="space-y-4">
                {['Threaded replies to keep conversations clean', 'Mark comments as resolved', 'Voice recording with Web Audio API'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-foreground font-medium">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Feature 2: Text Left, Visual Right */}
        <section className="px-6 py-24 md:py-32">
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center flex-col-reverse lg:flex-row">
            <div className="order-2 lg:order-1 space-y-8 w-full">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <History className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-4xl font-bold tracking-tight">Never lose track of a version again.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                "Final_v3_ACTUAL_final_v2.mp4" is dead. Upload or link new versions cleanly under the same project. Compare iterations and see what actually changed.
              </p>
              <ul className="space-y-4">
                {['Clean v1, v2, v3 organization', 'Keep old comments preserved on previous versions', 'Support for YouTube, Vimeo, and direct links'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-foreground font-medium">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="order-1 lg:order-2 aspect-square md:aspect-video lg:aspect-square bg-card rounded-3xl border shadow-xl flex items-center justify-center p-8 relative overflow-hidden w-full">
              <div className="absolute inset-0 bg-gradient-to-br from-background to-muted/50" />
              <div className="relative z-10 w-full max-w-sm space-y-3">
                {[3, 2, 1].map((v) => (
                  <div key={v} className={`p-4 rounded-xl border flex items-center justify-between ${v === 3 ? 'bg-background shadow-md border-primary/30' : 'bg-muted/30 opacity-60'}`}>
                    <div className="flex items-center gap-3">
                      <Video className="h-5 w-5 text-muted-foreground" />
                      <span className="font-semibold">Version {v}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{v === 3 ? 'Current' : '3 days ago'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Feature 3: Visual Left, Text Right */}
        <section className="px-6 py-24 md:py-32 bg-accent/30 border-y">
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center flex-col-reverse lg:flex-row">
            <div className="order-1 lg:order-1 aspect-square md:aspect-video lg:aspect-square bg-card rounded-3xl border shadow-xl flex items-center justify-center p-8 relative overflow-hidden w-full">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-primary/5 to-transparent" />
              <div className="relative z-10 grid grid-cols-2 gap-4 w-full max-w-sm">
                <div className="bg-background rounded-xl p-6 border text-center space-y-2 shadow-sm">
                  <Users className="h-6 w-6 mx-auto text-primary" />
                  <div className="font-semibold text-sm">Workspace</div>
                </div>
                <div className="bg-background rounded-xl p-6 border text-center space-y-2 shadow-sm">
                  <Share2 className="h-6 w-6 mx-auto text-primary" />
                  <div className="font-semibold text-sm">Guest Links</div>
                </div>
                <div className="col-span-2 bg-primary text-primary-foreground rounded-xl p-4 flex items-center justify-center gap-2 font-medium shadow-md">
                  Notifications (Email & Telegram)
                </div>
              </div>
            </div>
            <div className="order-2 lg:order-2 space-y-8 w-full">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Share2 className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-4xl font-bold tracking-tight">Share seamlessly.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Invite your core team to your workspace, or generate public links for clients.
                Guests can leave comments without dealing with the friction of creating an account.
              </p>
              <ul className="space-y-4">
                {['Public, Private, and Invite-only projects', 'Frictionless guest commenting', 'Telegram & Email webhook integrations'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-foreground font-medium">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Feature 4: Text Left, Visual Right */}
        <section className="px-6 py-24 md:py-32">
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center flex-col-reverse lg:flex-row">
            <div className="order-2 lg:order-1 space-y-8 w-full">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <PenTool className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-4xl font-bold tracking-tight">Communicate visually.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Sometimes words aren't enough. Draw directly on video frames to highlight exact details, and attach reference pictures directly to your comments.
              </p>
              <ul className="space-y-4">
                {['Draw and annotate on frames', 'Attach images to comments', 'Leave no room for ambiguity'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-foreground font-medium">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="order-1 lg:order-2 aspect-square md:aspect-video lg:aspect-square bg-card rounded-3xl border shadow-xl flex items-center justify-center p-8 relative overflow-hidden w-full">
              <div className="absolute inset-0 bg-gradient-to-br from-background to-muted/50" />
              <div className="relative z-10 w-full max-w-sm space-y-6">
                <div className="relative rounded-xl overflow-hidden border shadow-lg aspect-video bg-muted/30 flex items-center justify-center">
                  <Play className="h-8 w-8 text-muted-foreground/30" />
                  <svg className="absolute inset-0 w-full h-full text-primary stroke-current opacity-60" fill="none" viewBox="0 0 100 100" strokeWidth="2">
                    <ellipse cx="60" cy="45" rx="25" ry="35" className="animate-[pulse_3s_ease-in-out_infinite]" />
                  </svg>
                  <div className="absolute top-4 right-4 bg-background/90 p-2 rounded-lg border shadow-sm flex items-center justify-center">
                    <PenTool className="h-4 w-4 text-primary" />
                  </div>
                </div>
                <div className="bg-background rounded-xl p-4 border shadow-xl flex gap-4 ml-8 transform rotate-1">
                  <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">AI</div>
                  <div className="space-y-2 w-full">
                    <p className="text-sm font-medium">"Reference for the color grade:"</p>
                    <div className="h-20 w-32 bg-muted rounded-lg border border-dashed flex items-center justify-center overflow-hidden bg-[url('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=200')] bg-cover bg-center">
                      <ImageIcon className="h-5 w-5 text-white/50" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature 5: Visual Left, Text Right */}
        <section className="px-6 py-24 md:py-32 bg-accent/30 border-y">
          <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center flex-col-reverse lg:flex-row">
            <div className="order-1 lg:order-1 aspect-square md:aspect-video lg:aspect-square bg-card rounded-3xl border shadow-xl flex items-center justify-center p-8 relative overflow-hidden w-full">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_left,_var(--tw-gradient-stops))] from-primary/5 to-transparent" />
              <div className="relative z-10 w-full max-w-sm space-y-4">
                {/* AI Summary */}
                <div className="bg-background rounded-2xl p-5 border shadow-xl relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-primary to-primary/40" />
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="h-4 w-4 text-primary" />
                    <span className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">AI Intelligence</span>
                  </div>
                  <p className="text-sm font-medium leading-relaxed italic text-foreground/90">"User suggests the transition at 0:45 is too sharp. Prefer a smoother fade to match the music."</p>
                </div>
                {/* Export */}
                <div className="flex gap-4">
                  <div className="group bg-background flex-1 rounded-2xl p-4 border shadow-md flex items-center justify-center gap-3 font-bold text-sm text-foreground/80 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all cursor-pointer">
                    <FileText className="h-5 w-5 text-primary group-hover:text-primary-foreground transition-colors" /> PDF Export
                  </div>
                  <div className="group bg-background flex-1 rounded-2xl p-4 border shadow-md flex items-center justify-center gap-3 font-bold text-sm text-foreground/80 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all cursor-pointer">
                    <FileText className="h-5 w-5 text-primary group-hover:text-primary-foreground transition-colors" /> CSV Export
                  </div>
                </div>
              </div>
            </div>
            <div className="order-2 lg:order-2 space-y-8 w-full">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-4xl font-bold tracking-tight">Powerful workflows.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Let AI summarize long-winded voice notes automatically, and export all your project feedback into neat PDF or CSV files ready for the team.
              </p>
              <ul className="space-y-4">
                {['AI-powered voice summaries', 'One-click PDF/CSV exports', 'Structured feedback data'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-foreground font-medium">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Business Model Section */}
        <section className="px-6 py-32 relative overflow-hidden">
          <div className="absolute inset-0 bg-background border-t" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-primary/10 blur-[120px] rounded-full pointer-events-none" />

          <div className="relative max-w-4xl mx-auto text-center space-y-12 z-10">
            <div className="space-y-4">
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Open Source or Managed. <br /> Your call.</h2>
              <p className="text-xl text-muted-foreground w-full max-w-2xl mx-auto">
                We believe in code freedom. Self-host it if you like configuring servers, or use our managed platform if you value your time.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6 text-left items-stretch">
              <div className="bg-card border rounded-3xl p-8 shadow-sm relative overflow-hidden flex flex-col h-full">
                <div className="absolute top-0 right-0 p-6 opacity-10">
                  <Github className="h-24 w-24 z-0" />
                </div>
                {/* Visual alignment block to match the other card's badge */}
                <div className="mb-12 relative z-10 pt-8">
                  <h3 className="text-2xl font-bold mb-2">Self-Hosted</h3>
                  <p className="text-muted-foreground">Grab the code. Deploy it on your own infrastructure. It's 100% free and open source.</p>
                </div>
                <div className="mt-auto relative z-10">
                  <Button asChild variant="outline" className="w-full h-12 rounded-xl">
                    <a href="https://github.com/yusufipk/OpenFrame" target="_blank" rel="noreferrer">
                      <Github className="mr-2 h-4 w-4" /> View Source
                    </a>
                  </Button>
                </div>
              </div>

              <div className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20 border rounded-3xl p-8 shadow-lg relative overflow-hidden flex flex-col h-full">
                <div className="absolute top-0 right-0 p-6 opacity-10">
                  <Server className="h-24 w-24 text-primary z-0" />
                </div>
                <div className="mb-12 relative z-10">
                  <div className="inline-flex items-center self-start gap-2 px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-bold uppercase tracking-wider mb-2 border border-primary/20">
                    Recommended
                  </div>
                  <h3 className="text-2xl font-bold mb-2">Managed Hosting</h3>
                  <p className="text-muted-foreground text-foreground/80">Skip the DevOps. Use open-frame.net. We handle the servers, storage, and updates.</p>
                </div>
                <div className="mt-auto relative z-10">
                  <Button asChild className="w-full h-12 rounded-xl shadow-lg shadow-primary/20">
                    <Link href="/register">Start on open-frame.net</Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t py-12 bg-card relative z-10">
        <div className="px-6 lg:px-8 max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 opacity-80">
            <Video className="h-5 w-5" />
            <span className="font-semibold tracking-tight">OpenFrame</span>
          </div>
          <div className="flex gap-8 text-sm text-muted-foreground font-medium">
            <Link href="https://github.com/yusufipk/OpenFrame" className="hover:text-primary transition-colors">GitHub</Link>
            <Link href="/login" className="hover:text-primary transition-colors">Sign In</Link>
            <Link href="/register" className="hover:text-primary transition-colors">Get Started</Link>
          </div>
          <p className="text-sm text-muted-foreground opacity-60">
            © {new Date().getFullYear()} OpenFrame. Constructed with precision.
          </p>
        </div>
      </footer>
    </div>
  );
}