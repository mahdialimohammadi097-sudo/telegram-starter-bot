// Build a standalone read-only query for a PostgreSQL console.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const [sourcePath, restoredPath, outputPath] = process.argv.slice(2);
const catalogQuery = await readFile(new URL("./ledger-catalog.sql", import.meta.url), "utf8");
const outputClause = "SELECT jsonb_build_array(kind,object_name,definition)::text";
const start = catalogQuery.indexOf(outputClause);
assert.ok(start >= 0 && catalogQuery.indexOf(outputClause, start + 1) === -1);

async function readCatalog(path) {
  const rows = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const entries = new Map(rows.map(([kind, name, value]) => [JSON.stringify([kind, name]), value]));
  assert.equal(entries.size, rows.length);
  assert.equal(rows.filter(([kind]) => kind === "table").length, 3);
  return entries;
}
const source = await readCatalog(sourcePath);
const restored = await readCatalog(restoredPath);
assert.deepEqual([...source.keys()].sort(), [...restored.keys()].sort());
const reference = [...source].map(([key, value]) => {
  const [kind, name] = JSON.parse(key);
  const accepted = [value];
  const other = restored.get(key);
  if (JSON.stringify(value) !== JSON.stringify(other)) accepted.push(other);
  return { kind, name, accepted };
});
const data = JSON.stringify(reference);
assert.ok(!data.includes("$reference$"));
const comparison = `, expected AS (
  SELECT kind, name AS object_name, accepted
  FROM jsonb_to_recordset($reference$${data}$reference$::jsonb)
    AS ref(kind text, name text, accepted jsonb)
), differences AS (
  SELECT kind, object_name,
    CASE WHEN expected.accepted IS NULL THEN 'extra'
         WHEN objects.definition IS NULL THEN 'missing'
         ELSE 'changed' END AS result
  FROM expected FULL JOIN objects USING (kind, object_name)
  WHERE expected.accepted IS NULL OR objects.definition IS NULL
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(expected.accepted) AS v(value)
                    WHERE v.value = objects.definition)
)
SELECT kind, object_name, result FROM differences
UNION ALL SELECT 'ledger', 'three tables', 'match' WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY 1, 2;
COMMIT;
`;
await writeFile(outputPath, catalogQuery.slice(0, start) + comparison);
