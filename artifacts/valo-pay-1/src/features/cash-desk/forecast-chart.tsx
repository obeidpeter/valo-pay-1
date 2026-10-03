import { useId } from "react";
import type { ForecastPoint as Point } from "./types";

export function ForecastChart({
  base,
  downside,
  opening,
}: {
  base: Point[];
  downside: Point[];
  opening: number;
}) {
  const id = useId();
  const all = [
    opening,
    ...base.map((p) => p.closingMinor),
    ...downside.map((p) => p.closingMinor),
  ];
  const low = Math.min(0, ...all),
    high = Math.max(1, ...all) * 1.1;
  const y = (value: number) => 145 - ((value - low) / (high - low)) * 122;
  const path = (points: Point[]) =>
    [
      `M 12 ${y(opening)}`,
      ...points.map((p) => `L ${12 + (p.day / 30) * 586} ${y(p.closingMinor)}`),
    ].join(" ");
  return (
    <svg
      viewBox="0 0 610 175"
      role="img"
      aria-labelledby={id}
      className="my-4 w-full overflow-visible"
    >
      <title id={id}>
        Cash forecast comparison. The table below lists the exact expected and
        cautious amounts.
      </title>
      {[0, 1, 2].map((n) => (
        <line
          key={n}
          x1="12"
          x2="598"
          y1={25 + n * 60}
          y2={25 + n * 60}
          stroke="currentColor"
          strokeOpacity=".1"
        />
      ))}
      <path
        d={path(base)}
        fill="none"
        stroke="currentColor"
        className="text-primary"
        strokeWidth="3"
      />
      <path
        d={path(downside)}
        fill="none"
        stroke="currentColor"
        className="text-amber-600 dark:text-amber-400"
        strokeWidth="2.5"
        strokeDasharray="7 5"
      />
      <text
        x="12"
        y="170"
        fill="currentColor"
        className="text-muted-foreground"
        fontSize="11"
      >
        Today
      </text>
      <text
        x="555"
        y="170"
        fill="currentColor"
        className="text-muted-foreground"
        fontSize="11"
      >
        30 days
      </text>
    </svg>
  );
}
