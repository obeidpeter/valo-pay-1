import { useId, type ComponentType } from "react";
import { Button } from "@/components/ui/button";

type Section = { id: string; label: string; description?: string; icon?: ComponentType<{ className?: string; "aria-hidden"?: true }> };

/** URL-backed page views use ordinary buttons, with their selected view and purpose visible at every width. */
export function SectionNavigation({ label, sections, value, onChange, controls }: {
  label: string;
  sections: readonly Section[];
  value: string;
  onChange: (value: string) => void;
  controls?: string;
}) {
  const descriptionId = useId();
  const current = sections.find(section => section.id === value);
  return <div className="space-y-3">
    <nav aria-label={label} className="flex flex-wrap gap-2 rounded-xl border bg-card p-2 print:hidden">
      {sections.map(section => <Button
        key={section.id}
        variant={value === section.id ? "default" : "ghost"}
        className="min-h-11"
        aria-current={value === section.id ? "page" : undefined}
        aria-pressed={value === section.id}
        aria-controls={controls}
        aria-describedby={value === section.id && current?.description ? descriptionId : undefined}
        onClick={() => onChange(section.id)}
      >
        {section.icon && <section.icon className="h-4 w-4" aria-hidden />}
        {section.label}
      </Button>)}
    </nav>
    {current?.description && <p id={descriptionId} className="text-sm leading-relaxed text-muted-foreground">{current.description}</p>}
  </div>;
}
