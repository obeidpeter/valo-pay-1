// A button inside a form submits that form unless it says otherwise, so a pager, a retry or any other control that is
// not the form's own submit button must be type="button" (the third review of the audit fixes found Previous and Next in
// the allocation and mandate pickers sending their dialog's form). setup.ts watches every form each test renders and
// fails the test when a control can submit its form without being marked as its submit button (type="submit").

/** Names a control, and the dialog or heading its form sits under, so a failure says which one to fix. */
function describe(button: HTMLButtonElement): string {
  const name = (button.getAttribute("aria-label") || button.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const dialog = button.closest("[role='dialog']");
  const where = dialog ? `dialog "${(dialog.querySelector("h1, h2, h3")?.textContent || "").trim()}"` : `form under "${(button.form?.closest("section, article, main")?.querySelector("h1, h2, h3")?.textContent || "the page").trim()}"`;
  return `button "${name}" in the ${where}`;
}

/** The buttons in `root` (itself included) that submit their form without being marked as its submit button. */
export function implicitSubmitters(root: ParentNode): string[] {
  const buttons = [...(root instanceof HTMLButtonElement ? [root] : []), ...root.querySelectorAll("button")];
  return buttons.filter(button => button.form && button.type === "submit" && button.getAttribute("type")?.trim().toLowerCase() !== "submit").map(describe);
}

/**
 * Checks each form of `target` as it is rendered, and as a control's type or form changes, until `take` returns what it
 * found. A control rendered and removed within one task is not seen; `take` checks the document as it stands as well.
 */
export function watchFormSubmitters(target: Document = document) {
  const found = new Set<string>();
  const check = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "attributes") for (const hit of implicitSubmitters(record.target as Element)) found.add(hit);
      else for (const node of record.addedNodes) if (node instanceof Element) for (const hit of implicitSubmitters(node)) found.add(hit);
    }
  };
  const observer = new MutationObserver(check);
  return {
    start() {
      found.clear();
      observer.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "form"] });
    },
    take(): string[] {
      check(observer.takeRecords());
      observer.disconnect();
      for (const hit of implicitSubmitters(target)) found.add(hit);
      return [...found];
    },
  };
}
