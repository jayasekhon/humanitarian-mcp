import duckdb from "duckdb";

const db = new duckdb.Database(":memory:");

export function runQuery(sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Very deliberately narrow: this tool is agent-facing, so we only allow
 * read-only SELECT queries against files we already know about. No ATTACH,
 * COPY, PRAGMA, INSTALL, or multi-statement input.
 */
export function assertSafeSelect(sql: string) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(trimmed)) {
    throw new Error("Only SELECT statements are allowed.");
  }
  if (/\b(attach|copy|pragma|install|load|create|insert|update|delete|drop|call)\b/i.test(trimmed)) {
    throw new Error("Query contains a disallowed keyword.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed.");
  }
  return trimmed;
}

export async function queryCsv(csvPath: string, sql: string, maxRows = 500) {
  const safeSql = assertSafeSelect(sql);
  // Expose the file as a view called `source` so the model doesn't need to
  // know the real path — it just writes SELECT ... FROM source ...
  await runQuery(`CREATE OR REPLACE TEMP VIEW source AS SELECT * FROM read_csv_auto('${csvPath}')`);
  const limited = /\blimit\b/i.test(safeSql) ? safeSql : `${safeSql} LIMIT ${maxRows}`;
  return runQuery(limited);
}

/**
 * Multi-source version: registers each {alias, csvPath} as its own view so
 * the SQL can JOIN across sources in one query, e.g.
 *   SELECT idp.admin0Name, jiaf."Total Population" FROM idp JOIN jiaf ON ...
 */
export async function queryMultipleCsv(
  sources: { alias: string; csvPath: string }[],
  sql: string,
  maxRows = 500
) {
  const safeSql = assertSafeSelect(sql);
  for (const s of sources) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s.alias)) {
      throw new Error(`Invalid alias "${s.alias}" — must be letters, numbers, or underscore only.`);
    }
    await runQuery(`CREATE OR REPLACE TEMP VIEW ${s.alias} AS SELECT * FROM read_csv_auto('${s.csvPath}')`);
  }
  const limited = /\blimit\b/i.test(safeSql) ? safeSql : `${safeSql} LIMIT ${maxRows}`;
  return runQuery(limited);
}
