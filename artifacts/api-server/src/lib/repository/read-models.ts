/** Internal repository read-models. Import through valo-pay-1-store; external access is rejected by the boundary check. */
import {
  allocatableOnly,
  allocationChoices,
  EXPIRED_EXPORT_STATUS,
  foldForSearch,
  listLimit,
  LIST_PAGE_CEILING,
  matchesSearch,
  updatedSinceInstant,
  type ListQuery,
} from "../valo-pay-1-list";
import {
  allocationClosedStatuses,
  measurementRules,
} from "@workspace/valo-pay-1-schema";
import { allocationPayer } from "../../domain/reconciliation";
import type { DomainState, ValopayRecord } from "../../domain/types";
import { publicExportRecord } from "../export-jobs";
import { notFound } from "../refusal-words";
import {
  queueView,
  queueViews,
  type QueueName,
  type QueueQuery,
} from "../valo-pay-1-queues";
import {
  validateCloseRange,
  pageOffset,
  type ReadPageQuery,
  type ReconciliationQueue,
} from "../console-read-models";
import { precisionAudit } from "../../domain/reports";
import { periodBounds, previousMonth } from "../../domain/billing";
import {
  historySections,
  historyKind,
  positionNote,
  type CustomerHistoryQuery,
  type HistorySection,
} from "../customer-history";
import { databaseMoney } from "../database-money";
import { sumMoney } from "@workspace/valo-pay-1-schema";
import type { StoreContext, RecordRow } from "./types";
type Dependencies = Pick<
  typeof import("./core"),
  "sessionFor" | "readMerchant" | "closeSummarySql" | "rowToRecord" | "fail"
>;

export function createReadModelsRepository(dependencies: Dependencies) {
  const { sessionFor, readMerchant, closeSummarySql, rowToRecord } =
    dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  const recordColumns =
    "r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,r.data,r.created_at,r.updated_at";
  const scopedRecordsFrom = `FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
  JOIN valopay_workspaces w ON w.id=m.workspace_id`;
  const scopedRecordsWhere =
    "r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3";

  /** A list never loads unrelated kinds or constructs a writable DomainState.
   * No search: PostgreSQL calculates the count and returns only the page.
   * Search: the JavaScript fold (matchesSearch) over each record's name,
   * reference and data values as the list shows them (an export without its
   * private storage fields), scanning bounded batches of this kind; only the
   * requested page is retained. Search indexing is a separate change. Closes are
   * listed, and searched, as their summaries, as the reports view reads them: a
   * whole close carries its full report (about 100 KB), which the close history
   * opens one at a time (getCloseDetail).
   */
  async function listRecords(
    context: StoreContext,
    merchantId: string,
    kind: string,
    query: ListQuery,
  ) {
    const session = sessionFor(context);
    await readMerchant(context, merchantId);
    const columns =
      kind === "closes"
        ? recordColumns.replace("r.data", `${closeSummarySql} AS data`)
        : recordColumns;
    const params: unknown[] = [
      merchantId,
      session.workspace.id,
      session.principal,
      kind,
    ];
    let where = `${scopedRecordsWhere} AND r.kind=$4`;
    const filter = (column: string, value: unknown) => {
      params.push(value);
      where += ` AND ${column}=$${params.length}`;
    };
    if (query.status && query.status !== "all") {
      // inListStatus: a saved export whose file retention removed is listed as expired, never under its job's status.
      const removed = "coalesce(r.data->>'fileDeletedAt','') <> ''";
      if (kind !== "exports") filter("r.status", query.status);
      else if (query.status === EXPIRED_EXPORT_STATUS)
        where += ` AND ${removed}`;
      else {
        filter("r.status", query.status);
        where += ` AND NOT ${removed}`;
      }
    }
    if (query.customerId) filter("r.customer_id", query.customerId);
    if (query.id) filter("r.id", query.id);
    // canTakeAllocation in SQL: something still owed (the outstanding balance when it is a whole number, else the amount), a status that takes one,
    // and no hold for a renewed reversal review (a non-empty legacyReversalReviewIds list). CASE tries its conditions in order, so a balance is read as
    // a number only once it is known to be one, and a list's length is read only once it is known to be a list.
    if (allocatableOnly(kind, query)) {
      params.push([...allocationClosedStatuses]);
      where +=
        ` AND r.status <> ALL($${params.length}::text[]) AND (CASE WHEN jsonb_typeof(r.data->'outstandingKobo') IS DISTINCT FROM 'number' THEN r.amount_kobo WHEN (r.data->>'outstandingKobo')::numeric % 1 <> 0 THEN r.amount_kobo ELSE (r.data->>'outstandingKobo')::numeric END) > 0` +
        ` AND (CASE WHEN jsonb_typeof(r.data->'legacyReversalReviewIds') = 'array' THEN jsonb_array_length(r.data->'legacyReversalReviewIds') = 0 ELSE true END)`;
      // One payment's choices: the payer rule of its manual allocation (allocationPayer) becomes a customer filter.
      if (query.paymentId !== undefined) {
        const scope = [merchantId, session.workspace.id, session.principal];
        const row = (
          await session.client.query<RecordRow>(
            `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='payments' AND r.id=$4`,
            [...scope, query.paymentId],
          )
        ).rows[0];
        const payment = row
          ? rowToRecord(row)
          : fail(
              "Payment not found. Reload the payments and choose one again.",
              404,
            );
        const named =
          !payment.customerId &&
          typeof payment.data.dueItemId === "string" &&
          payment.data.dueItemId
            ? (
                await session.client.query<{ customer_id: string }>(
                  `SELECT r.customer_id ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='due-items' AND r.id=$4`,
                  [...scope, payment.data.dueItemId],
                )
              ).rows[0]?.customer_id
            : undefined;
        const choices = allocationChoices(
          query,
          allocationPayer(payment, named),
        );
        if (!choices) return { items: [], total: 0 };
        if (choices.customerId !== query.customerId)
          filter("r.customer_id", choices.customerId);
      }
    }
    if (query.updatedSince) {
      params.push(
        new Date(updatedSinceInstant(query.updatedSince)).toISOString(),
      );
      where += ` AND r.updated_at >= $${params.length}::timestamptz`;
    }
    const offset =
      Number.isInteger(query.offset) && Number(query.offset) > 0
        ? Number(query.offset)
        : 0;
    // A kind that grows with history is capped even without a limit (listLimit).
    const limit = listLimit(kind, query.limit);
    let items: ValopayRecord[] = [],
      total: number;
    if (!query.search) {
      // The read's snapshot keeps the separate total and page coherent with writes.
      total = Number(
        (
          await session.client.query<{ total: string }>(
            `SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${where}`,
            params,
          )
        ).rows[0]!.total,
      );
      const values = [...params, offset];
      let paging = ` OFFSET $${values.length}`;
      if (limit !== undefined) {
        values.push(limit);
        paging += ` LIMIT $${values.length}`;
      }
      if (offset < total)
        items = (
          await session.client.query<RecordRow>(
            `SELECT ${columns} ${scopedRecordsFrom} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC${paging}`,
            values,
          )
        ).rows.map(rowToRecord);
    } else {
      const search = foldForSearch(query.search);
      total = 0;
      let cursor: { at: string; id: string } | undefined;
      while (true) {
        const values = [...params];
        let after = "";
        if (cursor) {
          values.push(cursor.at, cursor.id);
          after = ` AND (r.created_at,r.id) < ($${values.length - 1}::timestamptz,$${values.length}::text)`;
        }
        const batch = (
          await session.client.query<RecordRow & { cursor_at: string }>(
            `SELECT ${columns},r.created_at::text AS cursor_at ${scopedRecordsFrom} WHERE ${where}${after} ORDER BY r.created_at DESC,r.id DESC LIMIT ${LIST_PAGE_CEILING}`,
            values,
          )
        ).rows;
        for (const row of batch) {
          const record = rowToRecord(row);
          if (
            !matchesSearch(
              record.kind === "exports" ? publicExportRecord(record) : record,
              search,
            )
          )
            continue;
          if (total >= offset && (limit === undefined || items.length < limit))
            items.push(record);
          total++;
        }
        if (batch.length < LIST_PAGE_CEILING) break;
        const last = batch.at(-1)!;
        cursor = { at: last.cursor_at, id: last.id };
      }
    }
    const nextOffset =
      offset + items.length < total ? offset + items.length : undefined;
    return nextOffset === undefined
      ? { items, total }
      : { items, total, nextOffset };
  }

  /** Priority queues are counted and paged by PostgreSQL. Only the page and its
   * linked records cross the repository boundary; no writable state is loaded. */
  async function listQueue(
    context: StoreContext,
    merchantId: string,
    queue: QueueName,
    query: QueueQuery,
  ) {
    const session = sessionFor(context);
    await readMerchant(context, merchantId);
    const view = queueView(queue, query.view),
      limit = query.limit || 25;
    const values: unknown[] = [
      merchantId,
      session.workspace.id,
      session.principal,
      context.now,
      query.owner || "",
      query.type || "",
      query.record || "",
      foldForSearch(query.q || ""),
    ];
    // PostgreSQL 16's input check also handles malformed legacy dates without failing a queue.
    const timestamp = (text: string) =>
      `CASE WHEN pg_input_is_valid(${text},'timestamp with time zone') THEN (CASE WHEN length(${text})=10 THEN ${text} || 'T00:00:00Z' ELSE ${text} END)::timestamptz END`;
    // When a deadline passes (deadlineEnds in the shared schema): a date-only one at the end of its WAT day, so it is
    // due all day and overdue after it; an impossible date (2026-02-30) is no deadline.
    const deadlineAt = (
      text: string,
    ) => `CASE WHEN (${text}) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (CASE WHEN pg_input_is_valid(${text},'date') THEN ((${text}) || 'T23:59:59.999+01:00')::timestamptz END)
    WHEN pg_input_is_valid(${text},'timestamp with time zone') THEN (${text})::timestamptz END`;
    const dueData = `CASE WHEN r.kind='attempts' THEN d.data ELSE r.data END`;
    const deadline =
      queue === "exceptions"
        ? "r.data->>'dueBy'"
        : queue === "mandates"
          ? "r.data->>'activationDeadline'"
          : `(${dueData})->>'dueDate'`;
    const owner =
      queue === "collections"
        ? `coalesce(nullif((${dueData})->>'owner',''),'unassigned')`
        : "coalesce(nullif(r.data->>'owner',''),'Unassigned')";
    const kind =
      queue === "collections"
        ? "(r.kind='due-items' OR r.kind='attempts' AND r.status='failed')"
        : `r.kind='${queue}'`;
    const unpaid = `coalesce((CASE WHEN r.kind='attempts' THEN d.status ELSE r.status END) NOT IN ('paid','closed','cancelled'),false)`;

    // Count/order only this queue's kinds. A failed attempt's instalment is read
    // by primary key from the same lender, one index probe per attempt: joining
    // the scoped set to itself made PostgreSQL compare every attempt with every
    // instalment (38 million pairs for one page of a 6,000-instalment lender).
    // OFFSET 0 keeps the lookup a primary-key probe whatever the statistics say:
    // as a plain join, a lender loaded since the last ANALYZE was estimated at
    // one row and each attempt scanned all its instalments (22 s for a
    // 25,000-record lender, past the statement limit). The lender and kind are
    // checked on the row the probe found.
    // A search term is matched once per queue row, in a lateral column (OFFSET 0 keeps it from being written back into
    // every filter) that the counts, the total, the page and its target all read, and against a customer only by a probe
    // of the row's own customer (OFFSET 0 keeps it a probe, which PostgreSQL caches per customer), so a customer the
    // queue holds many times is folded once and one it does not hold is never read. Written into each filter, the search
    // was folded again for every count, with a customer lookup and fold per row each time: about 300 ms for a searched
    // pilot-scale collections queue. Without a search term none of it is in the statement.
    const searching = values[7] !== "";
    const searchText = (expression: string) =>
      `lower(regexp_replace(normalize(${expression},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
    const matched = searching
      ? `
        LEFT JOIN LATERAL (SELECT true AS hit FROM valopay_records c WHERE c.id=r.customer_id AND c.merchant_id=$1 AND c.kind='customers' AND position($8 in ${searchText("concat_ws(' ',c.name,c.reference)")})>0 OFFSET 0) customer ON true
        CROSS JOIN LATERAL (SELECT (customer.hit IS NOT NULL OR position($8 in ${searchText("concat_ws(' ',r.name,r.reference)")})>0) AS matched OFFSET 0) m`
      : "";
    const cte = `WITH scoped AS (SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${kind}),
    b AS (SELECT r.*,${searching ? " m.matched," : ""} ${deadlineAt(deadline)} AS deadline_at, ${owner} AS queue_owner,
      ${unpaid} AS unpaid, ${timestamp("r.data->>'occurredAt'")} AS attempt_at
      FROM scoped r LEFT JOIN LATERAL (SELECT d.merchant_id,d.kind,d.status,d.data FROM valopay_records d WHERE r.kind='attempts' AND d.id=r.data->>'dueItemId' OFFSET 0) d
        ON d.merchant_id=r.merchant_id AND d.kind='due-items'${matched} WHERE ${kind}),
    q AS (SELECT b.*,coalesce(deadline_at < $4::timestamptz,false) AS overdue,
      coalesce(to_char(deadline_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') = to_char($4::timestamptz AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD'),false) AS today FROM b)`;
    const conditions: Record<string, string> =
      queue === "exceptions"
        ? {
            open: "status NOT IN ('closed','resolved')",
            high: "status NOT IN ('closed','resolved') AND data->>'severity'='high'",
            overdue: "status NOT IN ('closed','resolved') AND overdue",
            "due-today": "status NOT IN ('closed','resolved') AND today",
            resolved: "status IN ('closed','resolved')",
          }
        : queue === "mandates"
          ? {
              all: "true",
              "awaiting-activation": "status='pending_activation'",
              overdue: "status='pending_activation' AND overdue",
              "due-today": "status='pending_activation' AND today",
            }
          : {
              all: "kind='due-items'",
              overdue: "kind='due-items' AND unpaid AND overdue",
              "due-today": "kind='due-items' AND unpaid AND today",
              failed: "kind='attempts'",
            };
    // Without a search term the statement still names $8, so PostgreSQL knows its type.
    const ownerFilter = `${searching ? "matched" : "$8=''"} AND ($5='' OR queue_owner=$5) AND ($6='' OR data->>'type'=$6)`;
    const selected = `${ownerFilter} AND (CASE WHEN $7<>'' THEN id=$7 ELSE (${conditions[view]}) END)`;
    const order =
      (queue === "exceptions"
        ? "overdue DESC,CASE data->>'severity' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,"
        : queue === "mandates"
          ? "(status='pending_activation') DESC,"
          : "(unpaid AND overdue) DESC,unpaid DESC,") +
      `deadline_at ASC NULLS LAST,${queue === "collections" ? "attempt_at ASC NULLS LAST," : ""}id COLLATE "C"`;
    const summary = (
      await session.client.query<{
        counts: Record<string, number>;
        owners: string[];
        types: string[];
        total: string;
      }>(
        `${cte} SELECT
    json_build_object(${queueViews[queue].map((key) => `'${key}',count(*) FILTER (WHERE ${ownerFilter} AND (${conditions[key]}))`).join(",")}) AS counts,
    coalesce(array_agg(DISTINCT queue_owner),ARRAY[]::text[]) AS owners,
    coalesce(array_agg(DISTINCT coalesce(data->>'type','unknown')),ARRAY[]::text[]) AS types,
    count(*) FILTER (WHERE ${selected}) AS total FROM q`,
        values,
      )
    ).rows[0]!;
    const total = Number(summary.total);
    let offset = Math.min(
      query.offset || 0,
      Math.max(0, Math.ceil(total / limit) - 1) * limit,
    );
    if (query.target) {
      const located = (
        await session.client.query<{ position: string }>(
          `${cte}, ranked AS (SELECT id,row_number() OVER (ORDER BY ${order})-1 AS position FROM q WHERE ${selected}) SELECT position FROM ranked WHERE id=$9`,
          [...values, query.target],
        )
      ).rows[0];
      if (located)
        offset = Math.floor(Number(located.position) / limit) * limit;
    }
    const items = (
      await session.client.query<RecordRow>(
        `${cte} SELECT * FROM q WHERE ${selected} ORDER BY ${order} OFFSET $9 LIMIT $10`,
        [...values, offset, limit],
      )
    ).rows.map(rowToRecord);
    const related = new Map<string, ValopayRecord>();
    // Up to three link hops: attempt → instalment → mandate → policy. Each hop is lender scoped.
    for (let hop = 0; hop < 3; hop++) {
      const ids = [
        ...new Set(
          [...items, ...related.values()]
            .flatMap((row) => [
              row.customerId,
              row.data.dueItemId,
              row.data.mandateId,
              row.data.policyId,
            ])
            .filter(
              (id): id is string =>
                typeof id === "string" && !!id && !related.has(id),
            ),
        ),
      ];
      if (!ids.length) break;
      const rows = (
        await session.client.query<RecordRow>(
          `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind IN ('customers','due-items','mandates','policies') AND r.id=ANY($4::text[])`,
          values.slice(0, 3).concat([ids]),
        )
      ).rows;
      for (const row of rows) related.set(row.id, rowToRecord(row));
    }
    const dueIds = [...items, ...related.values()]
      .filter((row) => row.kind === "due-items")
      .map((row) => row.id);
    if (dueIds.length) {
      const rows = (
        await session.client.query<RecordRow>(
          `SELECT DISTINCT ON (r.data->>'dueItemId') ${recordColumns} ${scopedRecordsFrom}
      WHERE ${scopedRecordsWhere} AND r.kind='attempts' AND r.status='failed' AND r.data->>'dueItemId'=ANY($4::text[])
      ORDER BY r.data->>'dueItemId',coalesce(${timestamp("r.data->>'occurredAt'")},r.created_at) DESC,r.id COLLATE "C"`,
          values.slice(0, 3).concat([dueIds]),
        )
      ).rows;
      for (const row of rows) related.set(row.id, rowToRecord(row));
    }
    if (queue === "mandates" && query.record) {
      const rows = (
        await session.client.query<RecordRow>(
          `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='mandates' AND r.data->>'reissuedFrom'=$4 ORDER BY r.created_at DESC,r.id LIMIT 100`,
          values.slice(0, 3).concat(query.record),
        )
      ).rows;
      for (const row of rows) related.set(row.id, rowToRecord(row));
    }
    return {
      items,
      related: [...related.values()],
      total,
      offset,
      counts: summary.counts,
      owners: summary.owners.sort(),
      types: summary.types.sort(),
      asOf: context.now,
    };
  }

  /** All queue predicates execute on the same snapshot of the read transaction. */
  async function listReconciliation(
    context: StoreContext,
    merchantId: string,
    queue: ReconciliationQueue,
    query: ReadPageQuery,
  ) {
    const session = sessionFor(context),
      merchant = await readMerchant(context, merchantId);
    const scope = [merchantId, session.workspace.id, session.principal];
    const limit = query.limit || 25;
    const select = (where: string) =>
      `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`;
    let precision: ReturnType<typeof precisionAudit> | undefined;
    let sampledIds: string[] = [];
    if (queue === "audit") {
      const month = previousMonth(context.now),
        seed = `${merchantId}:${month}`,
        { start, end } = periodBounds(month);
      // The audit month is a WAT month: confirmedAt (or the creation time) as a UTC ISO string inside [start, end). Stored
      // instants are UTC timestamps or dates, which compare as strings in the "C" collation the way the domain parses them.
      const at = `coalesce(nullif(r.data->>'confirmedAt',''),to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) COLLATE "C"`;
      const predicate = `r.kind='allocations' AND r.status IN ('confirmed','superseded') AND r.data->'automatic'='true'::jsonb AND r.data->>'confidence'='certain' AND ${at}>=$4 AND ${at}<$5`;
      const population = Number(
        (
          await session.client.query<{ total: string }>(
            `SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${predicate}`,
            [...scope, start, end],
          )
        ).rows[0]!.total,
      );
      const sample = (
        await session.client.query<RecordRow>(
          `${select(predicate)} ORDER BY sha256(convert_to($6 || ':' || r.id,'UTF8')),r.id COLLATE "C" LIMIT $7`,
          [...scope, start, end, seed, measurementRules.precisionSampleSize],
        )
      ).rows.map(rowToRecord);
      precision = {
        ...precisionAudit(
          {
            merchant: merchant.info,
            settings: merchant.settings,
            records: sample,
          },
          context.now,
        ),
        population,
        requiredSample: Math.min(
          measurementRules.precisionSampleSize,
          population,
        ),
      };
      sampledIds = precision.sampledAllocationIds;
    }
    const conditions = {
      proposals: "r.kind='allocations' AND r.status='proposed'",
      duplicates: "r.kind='payments' AND r.status='possible_duplicate'",
      payments: `r.kind='payments' AND r.status IN ('unallocated','partial','overpaid') AND ${paymentUnappliedSql}>0`,
      observations: "r.kind='observations' AND r.status='unresolved'",
      audit: "r.kind='allocations' AND r.id=ANY($5::text[])",
      batches: "r.kind='settlement-batches'",
    };
    const due = query.dueItem
      ? (
          await session.client.query<RecordRow>(
            select("r.kind='due-items' AND r.id=$4"),
            [...scope, query.dueItem],
          )
        ).rows[0]
      : undefined;
    const related = new Map<string, ValopayRecord>();
    if (due) related.set(due.id, rowToRecord(due));
    // An unavailable focus fails closed rather than showing the whole lender.
    const focus = !query.dueItem
      ? "true"
      : !due
        ? "false"
        : queue === "proposals"
          ? "r.data->>'dueItemId'=$4"
          : queue === "observations"
            ? "(r.data->>'dueItemId'=$4 OR ($6<>'' AND r.customer_id=$6))"
            : "($6<>'' AND r.customer_id=$6)";
    // All parameters are referenced in every variant so PostgreSQL can infer their types.
    const fold = (value: string) =>
      `lower(regexp_replace(normalize(${value},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
    const searchFilter = `($7='' OR position($7 in ${fold("concat_ws(' ',r.name,r.reference)")})>0 OR EXISTS (
    SELECT 1 FROM valopay_records linked LEFT JOIN valopay_records customer ON customer.merchant_id=r.merchant_id AND customer.kind='customers' AND customer.id=linked.customer_id
    WHERE linked.merchant_id=r.merchant_id AND linked.kind IN ('customers','payments','due-items') AND linked.id=ANY(ARRAY[r.customer_id,r.data->>'paymentId',r.data->>'dueItemId'])
    AND position($7 in ${fold("concat_ws(' ',linked.name,linked.reference,customer.name,customer.reference)")})>0))`;
    const where = `${searchFilter} AND (${conditions[queue]}) AND (${focus}) AND $4::text IS NOT NULL AND $5::text[] IS NOT NULL AND $6::text IS NOT NULL`;
    const values = [
      ...scope,
      query.dueItem || "",
      sampledIds,
      due?.customer_id || "",
      foldForSearch(query.q || "").trim(),
    ];
    const total = Number(
      (
        await session.client.query<{ total: string }>(
          `SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`,
          values,
        )
      ).rows[0]!.total,
    );
    const offset = pageOffset(total, limit, query.offset);
    const items = (
      await session.client.query<RecordRow>(
        `${select(where)} ORDER BY r.created_at DESC,r.id DESC OFFSET $8 LIMIT $9`,
        [...values, offset, limit],
      )
    ).rows.map(rowToRecord);
    for (let hop = 0; hop < 2; hop++) {
      const ids = [
        ...new Set(
          [...items, ...related.values()]
            .flatMap((r) => [r.customerId, r.data.paymentId, r.data.dueItemId])
            .filter(
              (id): id is string =>
                typeof id === "string" && !!id && !related.has(id),
            ),
        ),
      ];
      if (!ids.length) break;
      const rows = (
        await session.client.query<RecordRow>(
          select(
            "r.kind IN ('customers','payments','due-items') AND r.id=ANY($4::text[])",
          ),
          [...scope, ids],
        )
      ).rows;
      for (const row of rows) related.set(row.id, rowToRecord(row));
    }
    return {
      items,
      related: [...related.values()],
      total,
      offset,
      asOf: context.now,
      ...(precision ? { precision } : {}),
    };
  }

  const closeSummaryData = `jsonb_strip_nulls(jsonb_build_object('summary',r.data->'summary','closedAt',r.data->'closedAt','schedule',r.data->'schedule','positionAlert',r.data->'positionAlert',
  'report',CASE WHEN r.data ? 'report' THEN jsonb_build_object('unallocated',jsonb_build_object('kobo',r.data#>'{report,unallocated,kobo}'),'exceptions',jsonb_build_object('openAtClose',r.data#>'{report,exceptions,openAtClose}')) END))`;

  async function listCloseHistory(
    context: StoreContext,
    merchantId: string,
    query: ReadPageQuery,
  ) {
    validateCloseRange(query.from, query.to);
    const session = sessionFor(context);
    await readMerchant(context, merchantId);
    const values = [
      merchantId,
      session.workspace.id,
      session.principal,
      query.from || "",
      query.to || "",
    ];
    const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes'`;
    const day =
      "to_char(r.created_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD')";
    const range = `($4='' OR ${day}>=$4) AND ($5='' OR ${day}<=$5)`;
    const counts = (
      await session.client.query<{ total: string; all_total: string }>(
        `SELECT count(*) AS all_total,count(*) FILTER(WHERE ${range}) AS total ${base}`,
        values,
      )
    ).rows[0]!;
    const total = Number(counts.total),
      limit = query.limit || 25,
      offset = pageOffset(total, limit, query.offset);
    const select = `SELECT ${recordColumns.replace("r.data", closeSummaryData + " AS data")} ${base} AND ${range}`;
    const items = (
      await session.client.query<RecordRow>(
        `${select} ORDER BY r.created_at DESC,r.id DESC OFFSET $6 LIMIT $7`,
        [...values, offset, limit],
      )
    ).rows.map(rowToRecord);
    const endpoints = total
      ? (
          await session.client.query<RecordRow>(
            `(${select} ORDER BY r.created_at,r.id LIMIT 1) UNION ALL (${select} ORDER BY r.created_at DESC,r.id DESC LIMIT 1)`,
            values,
          )
        ).rows.map(rowToRecord)
      : [];
    return {
      items,
      total,
      allTotal: Number(counts.all_total),
      offset,
      ...(total ? { first: endpoints[0]!, latest: endpoints[1]! } : {}),
    };
  }
  async function getCloseDetail(
    context: StoreContext,
    merchantId: string,
    id: string,
  ) {
    const session = sessionFor(context);
    await readMerchant(context, merchantId);
    const row = (
      await session.client.query<RecordRow>(
        `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes' AND r.id=$4`,
        [merchantId, session.workspace.id, session.principal, id],
      )
    ).rows[0];
    if (!row) fail(notFound("Daily close"), 404);
    return rowToRecord(row);
  }

  /** Read-only reports keep the measures needed by historical calculations, without
   * pulling large REC-07 evidence arrays into every summary request. */
  async function loadReportsView(
    context: StoreContext,
    merchantId: string,
  ): Promise<DomainState> {
    const session = sessionFor(context),
      merchant = await readMerchant(context, merchantId);
    const data = `CASE WHEN r.kind='closes' THEN ${closeSummarySql} ELSE r.data END AS data`;
    const rows = (
      await session.client.query<RecordRow>(
        `SELECT ${recordColumns.replace("r.data", data)} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind NOT IN ('audit','observations','notifications','retry-decisions') ORDER BY r.created_at,r.id`,
        [merchantId, session.workspace.id, session.principal],
      )
    ).rows;
    return {
      merchant: merchant.info,
      settings: merchant.settings,
      records: rows.map(rowToRecord),
    };
  }

  /** paymentRefundedKobo in SQL: for a refund (including the legacy spelling), data.refundedKobo when it is a whole non-negative safe number, else the whole payment. */
  const paymentRefundedSql = `(CASE WHEN coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') THEN CASE WHEN jsonb_typeof(r.data->'refundedKobo')='number'
  THEN CASE WHEN (r.data->>'refundedKobo')::numeric BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} AND (r.data->>'refundedKobo')::numeric=trunc((r.data->>'refundedKobo')::numeric) THEN (r.data->>'refundedKobo')::numeric ELSE r.amount_kobo END
  ELSE r.amount_kobo END ELSE 0 END)`;
  /** paymentMoneyReturned in SQL: reversed by the provider, or refunded in full. Returned money is no customer's credit. */
  const paymentReturnedSql = `(coalesce(r.data->>'reversalStatus','')='reversed' OR (coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') AND ${paymentRefundedSql}>=r.amount_kobo))`;
  /** paymentUnappliedKobo in SQL: what a payment holds that is neither applied nor returned by a refund. */
  const paymentUnappliedSql = `CASE WHEN ${paymentReturnedSql} THEN 0 ELSE greatest(0,r.amount_kobo-coalesce((r.data->>'allocatedKobo')::numeric,0)-${paymentRefundedSql}) END`;
  /** currencyOf in SQL: the currency a payment names, trimmed and in capitals, or NGN when it names none. */
  const paymentCurrencySql = `upper(btrim(coalesce(nullif(r.data->>'currency',''),'NGN'),E' \\t\\n\\r'))`;
  /** The payment is in naira. Money in another currency is no naira credit. */
  const paymentInNairaSql = `${paymentCurrencySql}='NGN'`;

  /** Read-only customer cards and events are paged; balances aggregate every related record. */
  async function getCustomerHistory(
    context: StoreContext,
    merchantId: string,
    id: string,
    query: CustomerHistoryQuery,
  ) {
    const session = sessionFor(context);
    await readMerchant(context, merchantId);
    const values = [merchantId, session.workspace.id, session.principal, id];
    const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere}`;
    const customerRow = (
      await session.client.query<RecordRow>(
        `SELECT ${recordColumns} ${base} AND r.kind='customers' AND r.id=$4`,
        values,
      )
    ).rows[0];
    if (!customerRow) fail(notFound("Customer"), 404);
    const totalsRow = (
      await session.client.query<Record<string, string>>(
        `SELECT count(*) AS events,
    count(*) FILTER(WHERE r.kind='mandates') AS mandates, count(*) FILTER(WHERE r.kind='due-items') AS "dueItems", count(*) FILTER(WHERE r.kind='payments') AS payments,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='due-items' AND r.status<>'cancelled'),0) AS obligations,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='allocations' AND r.status='confirmed'),0) AS allocated,
    coalesce(sum(${paymentUnappliedSql}) FILTER(WHERE r.kind='payments' AND ${paymentInNairaSql}),0) AS credit
    ${base} AND r.customer_id=$4`,
        values,
      )
    ).rows[0]!;
    const totals = {} as Record<HistorySection, number>,
      offsets = {} as Record<HistorySection, number>;
    const pages = {} as Record<HistorySection, ValopayRecord[]>;
    for (const section of historySections) {
      const limit = Math.min(query[`${section}Limit`] || 25, 100);
      totals[section] = Number(totalsRow[section]);
      offsets[section] = pageOffset(
        totals[section],
        limit,
        query[`${section}Offset`],
      );
      const predicate = historyKind[section]
        ? `AND r.kind='${historyKind[section]}'`
        : "";
      pages[section] = (
        await session.client.query<RecordRow>(
          `SELECT ${recordColumns} ${base} AND r.customer_id=$4 ${predicate} ORDER BY r.created_at DESC,r.id DESC OFFSET $5 LIMIT $6`,
          [...values, offsets[section], limit],
        )
      ).rows.map(rowToRecord);
    }
    const focusedRow = query.record
      ? (
          await session.client.query<RecordRow>(
            `SELECT ${recordColumns} ${base} AND r.customer_id=$4 AND r.id=$5`,
            [...values, query.record],
          )
        ).rows[0]
      : undefined;
    const obligationsKobo = databaseMoney(totalsRow.obligations!),
      allocatedKobo = databaseMoney(totalsRow.allocated!);
    // Money in another currency that the customer's payments hold unapplied, by currency, beside the naira credit (unallocatedOtherCurrencies).
    const elsewhere = (
      await session.client.query<{
        currency: string;
        count: string;
        amount: string;
      }>(
        `SELECT ${paymentCurrencySql} AS currency,count(*) AS count,sum(${paymentUnappliedSql}) AS amount
    ${base} AND r.customer_id=$4 AND r.kind='payments' AND NOT ${paymentInNairaSql} AND ${paymentUnappliedSql}>0 GROUP BY 1`,
        values,
      )
    ).rows.sort((a, b) =>
      a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0,
    );
    const unallocatedOtherCurrencies = elsewhere.length
      ? Object.fromEntries(
          elsewhere.map((row) => [
            row.currency,
            { count: Number(row.count), amount: databaseMoney(row.amount) },
          ]),
        )
      : undefined;
    return {
      customer: rowToRecord(customerRow),
      position: {
        obligationsKobo,
        allocatedKobo,
        outstandingKobo: Math.max(
          0,
          sumMoney([obligationsKobo, -allocatedKobo]),
        ),
        unallocatedKobo: databaseMoney(totalsRow.credit!),
        ...(unallocatedOtherCurrencies ? { unallocatedOtherCurrencies } : {}),
        note: positionNote,
      },
      ...pages,
      totals,
      offsets,
      ...(focusedRow ? { focusedRecord: rowToRecord(focusedRow) } : {}),
    };
  }

  /** Complete customer history and balances without every other customer's data.
   * This read has no mutable snapshot: passing it to saveState is rejected. */
  async function loadCustomerView(
    context: StoreContext,
    merchantId: string,
    customerId: string,
  ): Promise<DomainState> {
    const session = sessionFor(context),
      merchant = await readMerchant(context, merchantId);
    const records = (
      await session.client.query<RecordRow>(
        `SELECT ${recordColumns} ${scopedRecordsFrom}
    WHERE ${scopedRecordsWhere} AND ((r.kind='customers' AND r.id=$4) OR r.customer_id=$4) ORDER BY r.created_at,r.id`,
        [merchantId, session.workspace.id, session.principal, customerId],
      )
    ).rows.map(rowToRecord);
    return { merchant: merchant.info, settings: merchant.settings, records };
  }

  /**
   * Settings only need integrations, the calendar and the latest close,
   * summarised: the page shows when it ran and how, never a report. The latest
   * is the newest by creation, read through the paging index; a close's
   * closedAt is the time it was created (runDailyClose), so it is the one the
   * close schedule picks, and no other close's report is read.
   */
  async function loadSettingsView(
    context: StoreContext,
    merchantId: string,
  ): Promise<DomainState> {
    const session = sessionFor(context),
      merchant = await readMerchant(context, merchantId);
    const records = (
      await session.client.query<RecordRow>(
        `(SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind IN ('integrations','calendar'))
    UNION ALL (SELECT ${recordColumns.replace("r.data", `${closeSummarySql} AS data`)} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes' ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
    ORDER BY created_at,id`,
        [merchantId, session.workspace.id, session.principal],
      )
    ).rows.map(rowToRecord);
    return { merchant: merchant.info, settings: merchant.settings, records };
  }
  return {
    recordColumns,
    scopedRecordsFrom,
    scopedRecordsWhere,
    listRecords,
    listQueue,
    listReconciliation,
    listCloseHistory,
    getCloseDetail,
    loadReportsView,
    getCustomerHistory,
    loadCustomerView,
    loadSettingsView,
  };
}
