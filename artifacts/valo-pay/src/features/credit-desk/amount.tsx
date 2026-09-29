import { formatKobo } from "@/lib/formatters";

export function Amount({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums text-right ${strong ? "font-semibold" : ""}`}
      >
        {formatKobo(value)}
      </dd>
    </div>
  );
}
