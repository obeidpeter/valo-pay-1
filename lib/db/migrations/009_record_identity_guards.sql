-- Required before publishing this build; run as database owner once for each
-- application schema, including isolated runtime schemas, with that schema
-- first on search_path. Never run automatically at application startup.
-- Preserves all records. Duplicate identities abort before any schema change;
-- the error counts them and names up to five by lender and identity alone.
-- Repeatable. It drops the old event guard under any name: tables copied with
-- LIKE ... INCLUDING ALL, as a runtime schema's are, hold it under a generated
-- one, which earlier copies of this file, dropping it only by its name, left in
-- place. A host that applied one of those runs this again in each runtime
-- schema. The drop takes an ACCESS EXCLUSIVE lock on valopay_records until
-- COMMIT, so reads of the table wait for that moment too.
-- See docs/record-identity-migration.md for preflight and remediation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE valopay_records IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE duplicate record;
BEGIN
 IF EXISTS (SELECT 1 FROM valopay_records WHERE kind='observations' AND data->>'eventId' IS NOT NULL
   AND char_length(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), '')) > 200) THEN
   RAISE EXCEPTION 'A provider delivery identity exceeds 200 characters. Migration 009 changed nothing. Review its source mapping before retrying.';
 END IF;
 -- Each group of duplicates is named by its lender and identity alone: how many groups there are, and the first five.
 SELECT count(*) AS groups, string_agg(format('(%L, %L)', merchant_id, reference), ', ' ORDER BY place) FILTER (WHERE place <= 5) AS examples
  INTO duplicate FROM (
   SELECT merchant_id, reference, row_number() OVER (ORDER BY merchant_id, reference) AS place
    FROM valopay_records WHERE kind = 'customers' AND reference <> ''
    GROUP BY merchant_id, reference HAVING count(*) > 1
  ) grouped;
 IF duplicate.groups > 0 THEN
   RAISE EXCEPTION 'Duplicate customer references exist within a lender (groups to review: %). Migration 009 changed nothing. Review and correct the identities before retrying; no records were deleted.', duplicate.groups
    USING DETAIL = format('Up to five examples (lender, reference): %s.', duplicate.examples);
 END IF;
 SELECT count(*) AS groups, string_agg(format('(%L, %L, %L, %L)', merchant_id, namespace, source, event_id), ', ' ORDER BY place) FILTER (WHERE place <= 5) AS examples
  INTO duplicate FROM (
   SELECT *, row_number() OVER (ORDER BY merchant_id, namespace, source, event_id) AS place FROM (
    SELECT merchant_id,
      translate(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS namespace,
      coalesce(data->>'source', '') AS source, data->>'eventId' AS event_id
     FROM valopay_records WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL
     GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
   ) identities
  ) grouped;
 IF duplicate.groups > 0 THEN
   RAISE EXCEPTION 'Duplicate provider delivery identities exist within a lender (groups to review: %). Migration 009 changed nothing. Review the original evidence before retrying; no records were deleted.', duplicate.groups
    USING DETAIL = format('Up to five examples (lender, provider namespace, source, event ID): %s.', duplicate.examples);
 END IF;
END
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS valopay_unique_customer_reference ON valopay_records (merchant_id, reference)
 WHERE kind = 'customers' AND reference <> '';
CREATE UNIQUE INDEX IF NOT EXISTS valopay_unique_provider_event ON valopay_records (
 merchant_id,
 translate(coalesce(nullif(btrim(data->>'providerConnection'), ''), nullif(btrim(data->>'provider'), ''), ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
 coalesce(data->>'source', ''), (data->>'eventId')
) WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL;

DO $verify$
DECLARE wanted record; existing record; previous record; superseded record; table_schema text; old_index name;
 old_definition CONSTANT text := 'USING btree (merchant_id, ((data ->> ''source''::text)), ((data ->> ''eventId''::text))) WHERE ((kind = ''observations''::text) AND ((data ->> ''eventId''::text) IS NOT NULL))';
BEGIN
 FOR wanted IN SELECT * FROM (VALUES
  ('valopay_unique_customer_reference', 'USING btree (merchant_id, reference) WHERE ((kind = ''customers''::text) AND (reference <> ''''::text))'),
  ('valopay_unique_provider_event', 'USING btree (merchant_id, translate(COALESCE(NULLIF(btrim((data ->> ''providerConnection''::text)), ''''::text), NULLIF(btrim((data ->> ''provider''::text)), ''''::text), ''''::text), ''ABCDEFGHIJKLMNOPQRSTUVWXYZ''::text, ''abcdefghijklmnopqrstuvwxyz''::text), COALESCE((data ->> ''source''::text), ''''::text), ((data ->> ''eventId''::text))) WHERE ((kind = ''observations''::text) AND ((data ->> ''eventId''::text) IS NOT NULL))')
 ) AS expected(index_name, definition)
 LOOP
  SELECT i.indisvalid AS valid, i.indisunique AS is_unique,
    regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') AS definition
   INTO existing FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   WHERE i.indrelid=to_regclass('valopay_records') AND c.relname=wanted.index_name;
  IF NOT FOUND OR NOT existing.valid OR NOT existing.is_unique OR existing.definition <> wanted.definition THEN
   RAISE EXCEPTION 'Index % is not the reviewed definition. Migration 009 changed nothing; review the existing index.', wanted.index_name;
  END IF;
 END LOOP;
 -- The old guard's own name must hold only its reviewed definition.
 SELECT i.indisvalid AS valid,i.indisunique AS is_unique,
   regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') AS definition
  INTO previous FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE i.indrelid=to_regclass('valopay_records') AND c.relname='valopay_unique_observation';
 IF FOUND AND (NOT previous.valid OR NOT previous.is_unique OR previous.definition <> old_definition) THEN
  RAISE EXCEPTION 'The old observation guard is not the reviewed definition. Migration 009 changed nothing; review it first.';
 END IF;
 -- Drop the reviewed old guard under any name, after the new ones have been verified. One that is not valid, as a
 -- concurrent build that failed leaves it, may still be enforced on writes: it is left for review.
 SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FILTER (WHERE NOT i.indisvalid) AS invalid,
   array_agg(c.relname ORDER BY c.relname) FILTER (WHERE i.indisvalid) AS valid
  INTO superseded FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE i.indrelid=to_regclass('valopay_records') AND i.indisunique
   AND regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?\S+ ', '') = old_definition;
 IF superseded.invalid IS NOT NULL THEN
  RAISE EXCEPTION 'An index with the old observation guard''s definition is not valid (%). Migration 009 changed nothing; review it first.', superseded.invalid;
 END IF;
 SELECT n.nspname INTO table_schema FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid=to_regclass('valopay_records');
 FOREACH old_index IN ARRAY coalesce(superseded.valid, '{}') LOOP
  EXECUTE format('DROP INDEX %I.%I', table_schema, old_index);
 END LOOP;
END
$verify$;
COMMIT;
