import type { ReactNode } from "react";
import { cn } from "cn";
import { Button } from "~/components/ui/button";

/**
 * What a page or a section shows in place of content it does not have: nothing there yet,
 * or something that went wrong. `action` is the one thing the visitor can do about it.
 */
export function StateNotice({ title, hint, action, className }: { title: string; hint?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-4 rounded-2xl bg-fill px-6 py-10 text-center", className)}>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{title}</p>
        {hint !== undefined && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** For a section whose data failed to load, with a way to ask again. */
export function LoadFailed({ title, retry, onRetry }: { title: string; retry: string; onRetry: () => void }) {
  return <StateNotice title={title} className="py-6" action={<Button variant="secondary" size="sm" onClick={onRetry}>{retry}</Button>} />;
}

/** A grey block standing where content is about to appear. Size it with `className`. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-xl bg-fill", className)} />;
}
