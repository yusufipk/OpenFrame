import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

function PlayerPanelSkeleton() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r last:border-r-0">
      <div className="shrink-0 flex items-center justify-center h-10 px-4 border-b bg-muted/30">
        <Skeleton className="h-6 w-40 rounded-md" />
      </div>
      <div className="flex-1 bg-black" />
      <div className="shrink-0 px-4 py-2 bg-background border-t">
        <Skeleton className="h-4 w-24 mx-auto" />
      </div>
    </div>
  )
}

export default function CompareLoading() {
  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <PlayerPanelSkeleton />
        <PlayerPanelSkeleton />
      </div>
    </div>
  )
}
