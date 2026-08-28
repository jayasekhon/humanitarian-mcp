/**
 * build-catalog.ts
 *
 * Scans data/raw for .xlsx/.xls/.csv files, normalizes everything to CSV
 * under data/csv, profiles each file's columns, and writes data/catalog.json.
 *
 * Run this once, and re-run it any time you add/update a source file:
 *   npm run build-catalog
 *
 * MULTI-SHEET / MESSY-HEADER WORKBOOKS:
 * By default every sheet in a workbook is treated as its own catalog entry
 * (id = "{file}__{sheet}"), and the header is assumed to be row 1. Some
 * real-world files (e.g. JIAF exports with a stacked summary/group/header
 * row) need overrides. Put them in data/source-config.json, e.g.:
 *
 *   [
 *     { "file": "Sudan_-_JIAF_Humanitarian_Needs_and_Response_Plan_2026.xlsx",
 *       "sheet": "Cluster PIN", "header_row": 2 },
 *     { "file": "Sudan_-_JIAF_Humanitarian_Needs_and_Response_Plan_2026.xlsx",
 *       "sheet": "Cluster Severity", "header_row": 2 },
 *     { "file": "Sudan_-_JIAF_Humanitarian_Needs_and_Response_Plan_2026.xlsx",
 *       "sheet": "PiN Historical Trend", "header_row": 2 }
 *   ]
 *
 * header_row is 0-indexed (2 = the third row is the real header).
 *
 * IMPORTANT: after it runs, open data/catalog.json and fill in the
 * "description" and "keywords" fields by hand. That human-written context
 * is what actually fixes the "agent can't tell sources apart" problem —
 * column names alone are rarely enough for the model to guess intent.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const RAW_DIR = path.resolve("data/raw");
const CSV_DIR = path.resolve("data/csv");
const CATALOG_PATH = path.resolve("data/catalog.json");
const CONFIG_PATH = path.resolve("data/source-config.json");
const SAMPLE_ROWS = 5;
const MAX_SAMPLE_LEN = 120; // truncate long cell values (e.g. embedded JSON blobs) in samples

interface SourceOverride {
  file: string;
  sheet?: string; // if omitted, ALL sheets in the file are processed
  header_row?: number; // 0-indexed, default 0
}

function loadConfig(): SourceOverride[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

interface ColumnProfile {
  name: string;
  inferred_type: "number" | "date" | "text";
  sample_values: string[];
}

interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  source_file: string;
  csv_path: string;
  row_count: number;
  columns: ColumnProfile[];
  last_built: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferType(values: string[]): ColumnProfile["inferred_type"] {
  const nonEmpty = values.filter((v) => v !== "" && v != null);
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((v) => !isNaN(Number(v)))) return "number";
  if (nonEmpty.every((v) => !isNaN(Date.parse(v)))) return "date";
  return "text";
}

function truncate(v: string): string {
  return v.length > MAX_SAMPLE_LEN ? v.slice(0, MAX_SAMPLE_LEN) + "…" : v;
}

/**
 * sheet_to_csv has no "start row" option, so to skip N header rows we
 * clone the sheet's !ref range starting at headerRow before converting.
 */
function sheetToCsvFromRow(sheet: XLSX.WorkSheet, headerRow: number): string {
  if (headerRow > 0 && sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    range.s.r = headerRow;
    const adjusted: XLSX.WorkSheet = { ...sheet, "!ref": XLSX.utils.encode_range(range) };
    return XLSX.utils.sheet_to_csv(adjusted);
  }
  return XLSX.utils.sheet_to_csv(sheet);
}

function profileCsv(csvPath: string): { row_count: number; columns: ColumnProfile[] } {
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { row_count: 0, columns: [] };

  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const dataLines = lines.slice(1);

  const columns: ColumnProfile[] = headers.map((name, i) => {
    const values = dataLines
      .slice(0, 200)
      .map((line) => (line.split(",")[i] ?? "").replace(/^"|"$/g, "").trim());
    const samples = values.filter((v) => v !== "").slice(0, SAMPLE_ROWS).map(truncate);
    return { name, inferred_type: inferType(values), sample_values: samples };
  });

  return { row_count: dataLines.length, columns };
}

function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`No data/raw directory found. Put your .xlsx/.csv files in ${RAW_DIR} first.`);
    process.exit(1);
  }
  fs.mkdirSync(CSV_DIR, { recursive: true });

  const files = fs.readdirSync(RAW_DIR).filter((f) => /\.(xlsx|xls|csv)$/i.test(f));
  if (files.length === 0) {
    console.error(`No .xlsx/.xls/.csv files found in ${RAW_DIR}`);
    process.exit(1);
  }

  const overrides = loadConfig();

  // Preserve manually-written descriptions/keywords across rebuilds
  let existing: Record<string, CatalogEntry> = {};
  if (fs.existsSync(CATALOG_PATH)) {
    const prev: CatalogEntry[] = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
    existing = Object.fromEntries(prev.map((e) => [e.id, e]));
  }

  const catalog: CatalogEntry[] = [];

  function addEntry(
    file: string,
    csvPath: string,
    idSuffix: string,
    titleSuffix: string
  ) {
    const id = slugify(file) + idSuffix;
    const { row_count, columns } = profileCsv(csvPath);
    const prev = existing[id];

    catalog.push({
      id,
      title: prev?.title ?? file.replace(/\.[^/.]+$/, "") + titleSuffix,
      description:
        prev?.description ?? "TODO: describe what this dataset contains, its scope, and time period",
      keywords: prev?.keywords ?? [],
      source_file: file,
      csv_path: path.relative(process.cwd(), csvPath),
      row_count,
      columns,
      last_built: new Date().toISOString(),
    });

    console.log(`✓ ${file}${titleSuffix} -> ${id} (${row_count} rows, ${columns.length} cols)`);
  }

  for (const file of files) {
    const fullPath = path.join(RAW_DIR, file);
    const ext = path.extname(file).toLowerCase();
    const fileOverrides = overrides.filter((o) => o.file === file);

    if (ext === ".csv") {
      const headerRow = fileOverrides[0]?.header_row ?? 0;
      const csvPath = path.join(CSV_DIR, `${slugify(file)}.csv`);
      if (headerRow === 0) {
        fs.copyFileSync(fullPath, csvPath);
      } else {
        // drop the first N lines so row `headerRow` becomes the header
        const raw = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);
        fs.writeFileSync(csvPath, raw.slice(headerRow).join("\n"), "utf-8");
      }
      addEntry(file, csvPath, "", "");
      continue;
    }

    // xlsx/xls
    const wb = XLSX.readFile(fullPath);
    // If any override names specific sheets, process only those; otherwise process ALL sheets
    const namedSheets = fileOverrides.filter((o) => o.sheet).map((o) => o.sheet!);
    const sheetsToProcess = namedSheets.length > 0 ? namedSheets : wb.SheetNames;

    if (namedSheets.length === 0 && wb.SheetNames.length > 1) {
      console.log(`  ℹ ${file} has ${wb.SheetNames.length} sheets — processing all of them as separate sources.`);
    }

    for (const sheetName of sheetsToProcess) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) {
        console.warn(`  ⚠ Sheet "${sheetName}" not found in ${file}, skipping.`);
        continue;
      }
      const override = fileOverrides.find((o) => o.sheet === sheetName);
      const headerRow = override?.header_row ?? 0;
      const csv = sheetToCsvFromRow(sheet, headerRow);
      const idSuffix = wb.SheetNames.length > 1 ? `__${slugify(sheetName)}` : "";
      const csvPath = path.join(CSV_DIR, `${slugify(file)}${idSuffix}.csv`);
      fs.writeFileSync(csvPath, csv, "utf-8");
      addEntry(file, csvPath, idSuffix, wb.SheetNames.length > 1 ? ` — ${sheetName}` : "");
    }
  }

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
  console.log(`\nCatalog written to ${CATALOG_PATH}`);
  console.log(`Now open it and fill in "description"/"keywords" for each entry.`);
}

main();
