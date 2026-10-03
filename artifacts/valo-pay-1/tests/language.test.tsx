// The writing standard's mechanical rules, checked on the first view of every page of the console, as Admin
// (docs/design/writing.md, Checking your writing): each page has one name, used by its navigation link, its heading
// and the browser's title, and the words a reader sees carry no "&", em dash, arrow, straight apostrophe, raw code,
// retired page name or word the standard keeps from readers. Checksums and hashes may appear only inside a closed
// Technical details section, so the text inside a closed <details> other than its summary is not read. Dialogs,
// other roles and the states after an action are not read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

/** The standard's page table: each group's pages, in the navigation's order. */
const pageGroups: Array<[group: string, pages: Array<[path: string, name: string]>]> = [
  ["Daily work", [["/overview", "Overview"], ["/work", "My work"], ["/exceptions", "Exceptions"], ["/reconciliation", "Reconciliation"], ["/collections", "Collections"], ["/imports", "Import batches"], ["/close-review", "Close review"]]],
  ["Customers and policies", [["/customers", "Customers"], ["/mandates", "Mandates"], ["/policies", "Policies and templates"]]],
  ["Connected banking", [["/pay-by-bank", "Pay by Bank"], ["/credit-desk", "Credit Desk"], ["/cash-desk", "Cash Desk"], ["/connections", "Permissions and readiness"]]],
  ["Oversight", [["/reports", "Reports"], ["/exports", "Saved exports"], ["/audit", "Audit log"], ["/evidence", "Go-live evidence"]]],
  ["Setup and administration", [["/pilot", "Pilot journey"], ["/sources", "Data sources"], ["/operations", "Request history"], ["/team", "Team and access"], ["/lifecycle", "Data retention"], ["/settings", "Settings"], ["/presentation", "Presentation"]]],
];
const pages = pageGroups.flatMap(([, list]) => list);

/** Words the standard keeps from readers ("Things never shown to readers"), matched as whole words. */
const hiddenWords = [
  "principal", "digests?", "snapshots?", "payloads?", "idempoten\\w*", "journal\\w*", "leases?", "tombstones?", "fingerprints?",
  "hash(?:es)?", "checksums?", "provenance", "canonical", "schemas?", "record kinds?", "basis", "projections?",
  "workers?", "jobs?", "builds?", "hosts?", "webhooks?", "adapters?", "provision\\w*", "MFA",
];
const hiddenWord = new RegExp(`\\b(?:${hiddenWords.join("|")})\\b`, "gi");
/** Page and product names the standard retired. */
const retiredNames = /Pay-by-bank|pay-by-bank|Operations overview|Your pilot journey|Finance close review|Reports & analytics|Settings & administration|Team & access|Policies & templates|Permissions & readiness/g;
/**
 * A raw code: a lower-case code such as review_pending, an upper-case one such as REVIEW_PENDING, or a dotted one
 * such as post.records.customers. A dotted code stands on its own, so an e-mail address or a web address after
 * "https://" is not one. Words with hyphens, such as sign-in and read-only, are ordinary words.
 */
const rawCodes = [
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  /(?<![\w@./:-])[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+(?![\w@/-]|\.\w)/g,
];

/** The words a reader sees or hears on the page: its text and the names, titles, placeholders and alt text of its elements. */
function readerText(): string {
  const page = document.body.cloneNode(true) as HTMLElement;
  page.querySelectorAll("script, style, template, code, kbd, pre").forEach((element) => element.remove());
  page.querySelectorAll("details:not([open])").forEach((details) => {
    [...details.children].forEach((child) => { if (child.tagName !== "SUMMARY") child.remove(); });
  });
  const attributes = [...page.querySelectorAll("[aria-label], [title], [placeholder], [alt], [aria-description]")]
    .flatMap((element) => ["aria-label", "title", "placeholder", "alt", "aria-description"].map((name) => element.getAttribute(name) ?? ""));
  return [page.textContent ?? "", ...attributes, document.title].join("\n");
}

function problems(text: string): string[] {
  const found: string[] = [];
  const add = (rule: string, matches: Iterable<RegExpMatchArray>) => {
    for (const match of matches) found.push(`${rule}: …${text.slice(Math.max(0, match.index! - 40), match.index! + match[0].length + 40).replace(/\s+/g, " ")}…`);
  };
  add("ampersand", text.matchAll(/&/g));
  add("em dash", text.matchAll(/—/g));
  add("arrow", text.matchAll(/→|←|->|=>/g));
  add("straight apostrophe", text.matchAll(/[A-Za-z]'[A-Za-z]/g));
  add("retired name", text.matchAll(retiredNames));
  for (const rawCode of rawCodes) add("raw code", text.matchAll(rawCode));
  add("hidden word", text.matchAll(hiddenWord));
  return found;
}

/** Waits until the page and its panels have loaded. */
async function loaded() {
  await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading/), { timeout: 15_000 });
}

/** A navigation link's label: its text without the line under it that says what the page is for. */
function navigationLabel(link: Element): string {
  const label = link.cloneNode(true) as Element;
  label.querySelectorAll('[id$="-purpose"]').forEach((purpose) => purpose.remove());
  return label.textContent?.trim() ?? "";
}

describe("the rules", () => {
  it("finds each kind of raw code and a word kept from readers", () => {
    const rules = (text: string) => problems(text).map((problem) => problem.slice(0, problem.indexOf(":")));
    expect(rules("A review_pending mandate.")).toEqual(["raw code"]);
    expect(rules("The bank answered TIMEOUT_UNKNOWN.")).toEqual(["raw code"]);
    expect(rules("Recorded post.records.customers for this lender.")).toEqual(["raw code"]);
    expect(rules("The run is payroll-run.completed now.")).toEqual(["raw code"]);
    expect(rules("The fee is worked out on a daily basis.")).toEqual(["hidden word"]);
  });

  it("reads e-mail addresses, web addresses, numbers and words with hyphens as ordinary words", () => {
    expect(problems("Write to ops@valo-pay-1.example or ada.okonkwo@valo-pay-1.example. Open https://console.valo-pay-1.example/sign-in to sign in.")).toEqual([]);
    expect(problems("Read-only can view it. Sign-in is not available. Version 1.5 is ready.")).toEqual([]);
  });
});

describe("page names", () => {
  it("lists every page under its group in the navigation, by the standard's names", async () => {
    renderApp("/overview");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const [navigation] = await screen.findAllByRole("navigation", { name: "Pages" });
    const groups = [...navigation!.querySelectorAll('[role="group"]')].map((group) => [
      group.querySelector(".nav-group-label")?.textContent,
      [...group.querySelectorAll("a")].map((link) => [link.getAttribute("href"), navigationLabel(link)]),
    ]);
    expect(groups).toEqual(pageGroups);
  });

  it.each(pages)("names %s the same way in its heading and the browser's title", async (path, name) => {
    renderApp(path);
    await screen.findByRole("heading", { level: 1, name });
    await waitFor(() => expect(document.title).toBe(`${name} · Valo Pay 1`));
  });

  it("names Help the same way in its heading and the browser's title", async () => {
    renderApp("/help");
    await screen.findByRole("heading", { level: 1, name: "Help" });
    await waitFor(() => expect(document.title).toBe("Help · Valo Pay 1"));
  });
});

describe("reader text", () => {
  const ada = () => api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
  const anException = () => api.state().records.find((record) => record.kind === "exceptions")!;

  it.each([
    ...pages,
    ["/help", "Help"],
    ["/", "Collections, credit and cash. One clear view."],
    ["/sign-in", "Sign in"],
    ["/no-such-page", "Page not found"],
  ] as Array<[string, string]>)("keeps the words on %s to the standard", async (path, heading) => {
    renderApp(path);
    await screen.findByRole("heading", { level: 1, name: heading });
    await loaded();
    expect(problems(readerText())).toEqual([]);
  });

  it("keeps the words on a customer's history to the standard", async () => {
    renderApp(`/customers/${ada().id}`);
    await screen.findByRole("heading", { level: 1, name: /Ada Okonkwo/ });
    await loaded();
    await waitFor(() => expect(document.title).toBe("Customer history · Valo Pay 1"));
    expect(problems(readerText())).toEqual([]);
  });

  it("keeps the words on a case to the standard", async () => {
    renderApp(`/cases/${anException().id}`);
    await screen.findByRole("heading", { level: 1, name: /^Case/ });
    await loaded();
    await waitFor(() => expect(document.title).toBe("Case · Valo Pay 1"));
    expect(problems(readerText())).toEqual([]);
  });
});
