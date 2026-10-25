import { CLIENT_FORK_BUILD_VERSION } from "../../clientBuildVersion";
import { cn } from "../../lib/utils";
import { T3Wordmark } from "../T3Wordmark";

export function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
      <span
        className={cn(
          "ml-1 shrink-0 text-3xs font-normal tracking-normal",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        <span className="sr-only">Client fork build: </span>
        <span>{CLIENT_FORK_BUILD_VERSION}</span>
      </span>
    </span>
  );
}
