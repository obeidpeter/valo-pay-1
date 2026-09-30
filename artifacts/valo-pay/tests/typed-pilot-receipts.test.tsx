import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Workspace } from "@workspace/api-client-react";
import {
  valopayRecordSchema,
  type BatchInput,
} from "@workspace/valopay-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importBatchRecordSchema,
  type ImportBatch,
} from "@/features/imports/models";
import { INCOMPLETE_CONFIRMATION, readAnswer } from "@/lib/answers";
import { useTypedPilotMutation } from "@/lib/pilot";
import * as workspaceContext from "@/lib/workspace-context";
import { installFakeApi, type FakeApi } from "./fake-api";

let api: FakeApi;
let merchantId: string;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const batchInput = (): BatchInput => ({
  name: "Receipt recovery check",
  kind: "customers",
  source: "Loan system",
  sourceBatchId: "receipt-recovery-file",
  businessDate: "2026-09-29",
  mapping: {},
  amountUnit: "naira",
  identityColumn: "source_row_id",
  csv: "source_row_id,name,reference,consentProvenance\nrow-1,Sample,RECEIPT-C001,Synthetic consent",
  syntheticOnly: true,
});

beforeEach(async () => {
  sessionStorage.clear();
  api = installFakeApi({ now: "2026-09-29T10:00:00.000Z" });
  merchantId = api.merchantIds[0]!;
  const workspace = (await (
    await fetch("/api/v1/workspace")
  ).json()) as Workspace;
  vi.spyOn(workspaceContext, "useWorkspace").mockReturnValue({
    merchantId,
    workspace,
    setMerchantId: vi.fn(),
    isLoading: false,
    refreshFailure: null,
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  api.uninstall();
});

function mount(onSuccess = vi.fn<(batch: ImportBatch) => void>()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(
      () => useTypedPilotMutation(importBatchRecordSchema, onSuccess),
      { wrapper },
    ),
    onSuccess,
  };
}

describe("workflow-specific pilot confirmations", () => {
  it("keeps an unreadable saved check unconfirmed and recovers its original body, revision and key", async () => {
    const original = batchInput();
    const created = importBatchRecordSchema.parse(
      await (
        await fetch(`/api/v1/pilot/batches?merchantId=${merchantId}`, {
          method: "POST",
          body: JSON.stringify(original),
        })
      ).json(),
    );
    const path = `/pilot/batches/${created.id}/save`;
    const input = {
      path,
      data: {
        ...original,
        name: "Checked revision",
        expectedUpdatedAt: created.updatedAt,
      },
    };
    const originalBody = JSON.stringify(input.data);
    const send = globalThis.fetch;
    const requests: Array<{ key: string | null; body: string }> = [];
    let saved: ImportBatch | undefined;
    globalThis.fetch = async (url, options) => {
      if (
        new URL(String(url), "http://localhost").pathname !==
          `/api/v1${path}` ||
        options?.method !== "POST"
      )
        return send(url, options);
      requests.push({
        key: new Headers(options.headers).get("Idempotency-Key"),
        body: String(options.body),
      });
      // Model the journal: the first request commits once; its identical retry replays that receipt.
      if (saved) return json(saved);
      saved = importBatchRecordSchema.parse(
        await (await send(url, options)).json(),
      );
      const malformed = {
        ...saved,
        data: {
          ...saved.data,
          check: { ...saved.data.check, rows: "unreadable row checks" },
        },
      };
      expect(readAnswer(valopayRecordSchema, malformed)).toBeDefined();
      expect(readAnswer(importBatchRecordSchema, malformed)).toBeUndefined();
      return json(malformed);
    };
    const hook = mount();

    await act(async () => {
      await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(
        INCOMPLETE_CONFIRMATION,
      );
    });
    await waitFor(() =>
      expect(hook.result.current.hasUnconfirmedOutcome).toBe(true),
    );
    expect(hook.onSuccess).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBeTruthy();

    // A refreshed form can change its fields and revision while the original attempt remains frozen.
    input.data.csv += "\nrow-2,Another sample,RECEIPT-C002,Synthetic consent";
    input.data.expectedUpdatedAt = "2026-09-29T11:00:00.000Z";
    await act(async () => {
      await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(
        "Check the original request before you change anything",
      );
    });
    expect(requests).toHaveLength(1);

    let recovered: ImportBatch | undefined;
    await act(async () => {
      recovered = await hook.result.current.retryUnconfirmed();
    });
    await waitFor(() =>
      expect(hook.result.current.hasUnconfirmedOutcome).toBe(false),
    );
    expect(requests).toEqual([
      { key: requests[0]!.key, body: originalBody },
      { key: requests[0]!.key, body: originalBody },
    ]);
    expect(recovered?.data.check?.rows).toHaveLength(1);
    expect(recovered?.data.revision).toBe(2);
    expect(hook.onSuccess).toHaveBeenCalledExactlyOnceWith(recovered);
    expect(
      api.calls.filter(
        (call) => call.path === `/v1${path}` && call.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      api
        .state()
        .records.filter((record) => record.kind === "import-revisions"),
    ).toHaveLength(2);
    expect(
      api.state().records.find((record) => record.id === created.id)?.data.csv,
    ).toBe(original.csv);
  });

  it("still refuses another lender's otherwise valid workflow receipt", async () => {
    const send = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await send(url, options);
      if (
        new URL(String(url), "http://localhost").pathname !==
          "/api/v1/pilot/batches" ||
        options?.method !== "POST"
      )
        return response;
      const saved = importBatchRecordSchema.parse(await response.json());
      return json({ ...saved, merchantId: api.merchantIds[1] });
    };
    const hook = mount();
    await act(async () => {
      await expect(
        hook.result.current.mutateAsync({
          path: "/pilot/batches",
          data: batchInput(),
        }),
      ).rejects.toThrow("does not match this lender or request");
    });
    await waitFor(() =>
      expect(hook.result.current.hasUnconfirmedOutcome).toBe(true),
    );
    expect(hook.onSuccess).not.toHaveBeenCalled();
    expect(
      api.state().records.filter((record) => record.kind === "import-batches"),
    ).toHaveLength(1);
  });
});
