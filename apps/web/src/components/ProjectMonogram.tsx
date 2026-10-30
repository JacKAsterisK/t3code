import type { ProjectIconColor } from "@t3tools/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  round = false,
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  // Task owners are round, so a person never reads as a project.
  readonly round?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  // Wrap the tile to avoid menu/button SVG margin trimming.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden font-mono select-none",
          round ? "rounded-full" : "rounded-[25%]",
          projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
