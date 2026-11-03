import type { CSSProperties } from "react";

/** Lancer's native border, mounted only while this bubble/step is executing. */
export function RunningBorder({ active, color = "var(--lancer-current-lane-color, #3B82F6)" }: { active: boolean; color?: string }) {
  if (!active) return null;
  return <svg className="light-running-border lancer-execution-border" data-workbench-running-border aria-hidden="true" style={{ "--light-color": color } as CSSProperties}>
    <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="12" pathLength="100" />
  </svg>;
}
