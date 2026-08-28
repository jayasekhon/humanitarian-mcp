import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryCsv, queryMultipleCsv } from "./duckdb-client.js";

const CATALOG_PATH = path.resolve("data/catalog.json");

interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  csv_path: string;
  row_count: number;
  columns: { name: string; inferred_type: string; sample_values: string[] }[];
}

function loadCatalog(): CatalogEntry[] {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(
      `No catalog found at ${CATALOG_PATH}. Run "npm run build-catalog" after adding files to data/raw.`
    );
  }
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
}

function findSource(id: string): CatalogEntry {
  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === id);
  if (!entry) {
    const available = catalog.map((e) => e.id).join(", ");
    throw new Error(`Unknown source_id "${id}". Available: ${available}`);
  }
  return entry;
}

export function registerTools(server: McpServer) {
  server.tool(
    "list_data_sources",
    "List every available humanitarian data source with its title, description, keywords, " +
      "row count, and column names. ALWAYS call this first to see what data exists before " +
      "guessing which file to query.",
    {},
    async () => {
      const catalog = loadCatalog();
      const summary = catalog.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        keywords: e.keywords,
        row_count: e.row_count,
        columns: e.columns.map((c) => c.name),
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "get_schema",
    "Get the full column-level schema for one data source, including inferred types and " +
      "sample values for each column. Call this before writing a query so you know exact " +
      "column names and value formats.",
    { source_id: z.string().describe("The id of the source, from list_data_sources") },
    async ({ source_id }) => {
      const entry = findSource(source_id);
      return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.tool(
    "query_source",
    "Run a read-only SQL SELECT query against one data source to filter, aggregate, or sort " +
      "its rows. The table is always called `source` regardless of the underlying file — " +
      "e.g. SELECT country, SUM(amount) FROM source GROUP BY country ORDER BY 2 DESC. " +
      "Use get_schema first to confirm exact column names. Results are capped at 500 rows.",
    {
      source_id: z.string().describe("The id of the source, from list_data_sources"),
      sql: z.string().describe("A single SELECT statement. The table name must be `source`."),
    },
    async ({ source_id, sql }) => {
      const entry = findSource(source_id);
      try {
        const rows = await queryCsv(path.resolve(entry.csv_path), sql);
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Query failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "query_sources",
    "Run a read-only SQL SELECT that JOINS or compares rows across TWO OR MORE data sources in a " +
      "single query. Give each source an alias, then reference that alias as the table name in your " +
      "SQL. Example: sources=[{source_id:'sudan_-_idp_admin_0...',alias:'idp'}," +
      "{source_id:'...jiaf...__cluster_pin',alias:'jiaf'}], " +
      "sql=\"SELECT idp.admin0Name, jiaf.\\\"Total Population\\\" FROM idp JOIN jiaf ON ...\". " +
      "Call get_schema on each source first for exact column names. If the sources don't share a " +
      "common location key (P-code vs ISO3 vs plain name), include the 'sudan_geo_crosswalk' source " +
      "and join through it rather than assuming a direct match exists.",
    {
      sources: z
        .array(
          z.object({
            source_id: z.string().describe("A source id from list_data_sources"),
            alias: z.string().describe("Table name to use for this source in the SQL, e.g. 'idp'"),
          })
        )
        .min(2)
        .describe("Two or more sources to join, each with an alias"),
      sql: z.string().describe("A single SELECT statement referencing the aliases as table names."),
    },
    async ({ sources, sql }: any) => {
      try {
        const resolved = sources.map((s: { source_id: string; alias: string }) => ({
          alias: s.alias,
          csvPath: path.resolve(findSource(s.source_id).csv_path),
        }));
        const rows = await queryMultipleCsv(resolved, sql);
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Query failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_data_sources",
    "Search data sources by keyword when you're not sure which source_id to use. Matches " +
      "against title, description, keywords, and column names.",
    { keyword: z.string() },
    async ({ keyword }) => {
      const catalog = loadCatalog();
      const q = keyword.toLowerCase();
      const matches = catalog.filter((e) => {
        const haystack = [e.title, e.description, ...e.keywords, ...e.columns.map((c) => c.name)]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              matches.map((e) => ({ id: e.id, title: e.title, description: e.description })),
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
