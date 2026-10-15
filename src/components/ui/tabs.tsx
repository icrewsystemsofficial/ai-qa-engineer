import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Tabs({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/50 p-1", className)} role="tablist">{children}</div>;
}

export function Tab({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground", active && "bg-background text-foreground shadow-sm")}>{children}</button>;
}
