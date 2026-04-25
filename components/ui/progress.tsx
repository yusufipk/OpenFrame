import { cn } from '@/lib/utils';

function Progress({
  value = 0,
  className,
  ...props
}: React.ComponentProps<'div'> & { value?: number }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div className="h-full bg-primary transition-all" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export { Progress };
