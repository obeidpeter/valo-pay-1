import { useSearchParams } from "wouter";
import { Search } from "lucide-react";
import { Button } from "./ui/button";
import { useWorkspace } from "@/lib/workspace-context";
export function QueueSearch({
  label = "Search this queue",
  placeholder = "Customer name or reference",
  help = "Your filters still apply.",
  pagePrefixes = [],
}: {
  label?: string;
  placeholder?: string;
  help?: string;
  pagePrefixes?: string[];
} = {}) {
  const { merchantId } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const apply = (value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("page");
      for (const prefix of pagePrefixes) next.delete(prefix + "page");
      next.delete("record");
      if (value.trim()) next.set("q", value.trim());
      else next.delete("q");
      return next;
    });
  return (
    <form
      key={`${merchantId}:${q}`}
      className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        apply(String(new FormData(event.currentTarget).get("q") || ""));
      }}
    >
      <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium">
        {label}
        <input
          type="search"
          name="q"
          maxLength={200}
          defaultValue={q}
          placeholder={placeholder}
          className="min-h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
        />
      </label>
      <Button type="submit" variant="outline">
        <Search aria-hidden="true" className="mr-2 h-4 w-4" />
        Search
      </Button>
      {q && (
        <Button type="button" variant="ghost" onClick={() => apply("")}>
          Clear search
        </Button>
      )}
      {q && (
        <p role="status" className="w-full text-xs text-muted-foreground">
          Results matching “{q}”. {help}
        </p>
      )}
    </form>
  );
}
