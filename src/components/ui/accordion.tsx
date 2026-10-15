import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useId, useState } from "react";

export function Accordion({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function AccordionItem({
  title,
  description,
  children,
  defaultOpen = false,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn("border-b border-border last:border-b-0", className)}>
      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={id}>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{title}</span>{description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div id={id} className="border-t border-border px-4 py-4">{children}</div>}
    </div>
  );
}
