/**
 * build-geo-crosswalk.ts
 *
 * Builds data/raw/sudan_geo_crosswalk.csv by extracting real admin1
 * name <-> P-code pairs directly out of your own already-cataloged sources
 * (e.g. JIAF's "Admin 1"/"Admin 1 P-Code" columns, IDP's
 * idpOriginAdmin1Name/idpOriginAdmin1Pcode). This deliberately does NOT
 * hardcode any P-code list from outside knowledge — for humanitarian data,
 * a wrong P-code is worse than an unmapped row, so every mapping here
 * traces back to a file you provided.
 *
 * It also scans for plain-name-only location columns (like 3W's "State")
 * and flags any that couldn't be matched to a P-code from your other
 * sources, so you can fill those in by hand from an authoritative source
 * (search HDX for "Sudan COD-AB" — the OCHA Common Operational Dataset for
 * admin boundaries).
 *
 * USAGE (run in this order):
 *   npm run build-catalog      # first pass: builds catalog.json from data/raw
 *   npm run build-crosswalk    # derives the crosswalk from that catalog
 *   npm run build-catalog      # second pass: picks up the new crosswalk file as a source
 */
import fs from "node:fs";
import path from "node:path";

const CATALOG_PATH = path.resolve("data/catalog.json");
const OUTPUT_PATH = path.resolve("data/raw/sudan_geo_crosswalk.csv");

interface CatalogEntry {
  id: string;
  csv_path: string;
  columns: { name: string }[];
}

function parseCsv(csvPath: string): { headers: string[]; rows: string[][] } {
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
  return { headers, rows };
}

function findCol(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`No catalog.json found. Run "npm run build-catalog" first.`);
    process.exit(1);
  }
  const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));

  const pcodeByName = new Map<string, string>(); // lowercase name -> pcode
  const plainStateNames = new Set<string>();

  for (const entry of catalog) {
    const csvPath = path.resolve(entry.csv_path);
    if (!fs.existsSync(csvPath)) continue;
    const { headers, rows } = parseCsv(csvPath);

    const nameIdx = findCol(headers, [
      /^admin\s*1\s*name$/i,
      /^admin1name$/i,
      /idporiginadmin1name/i,
    ]);
    const pcodeIdx = findCol(headers, [
      /^admin\s*1\s*p.?code$/i,
      /^admin1pcode$/i,
      /idporiginadmin1pcode/i,
    ]);

    if (nameIdx >= 0 && pcodeIdx >= 0) {
      for (const row of rows) {
        const name = row[nameIdx]?.trim();
        const pcode = row[pcodeIdx]?.trim();
        if (name && pcode) pcodeByName.set(name.toLowerCase(), pcode);
      }
      console.log(`✓ Found ${pcodeByName.size} admin1 name/P-code pairs so far (from ${entry.id})`);
    }

    // Plain-name-only location columns, e.g. 3W's "State" — no P-code alongside it
    const stateIdx = findCol(headers, [/^state$/i, /^admin1$/i]);
    if (stateIdx >= 0 && pcodeIdx < 0) {
      for (const row of rows) {
        const name = row[stateIdx]?.trim();
        if (name) plainStateNames.add(name);
      }
    }
  }

  if (pcodeByName.size === 0) {
    console.error(
      "No admin1 name/P-code pairs found in any cataloged source. Nothing to build a crosswalk from."
    );
    process.exit(1);
  }

  const lines = ["admin1_name,admin1_pcode,matched_source_name,needs_review"];
  for (const [nameLower, pcode] of pcodeByName) {
    lines.push(`${nameLower},${pcode},${nameLower},false`);
  }

  const unmatched: string[] = [];
  for (const name of plainStateNames) {
    if (!pcodeByName.has(name.toLowerCase())) {
      unmatched.push(name);
      lines.push(`${name},,${name},true`);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf-8");

  console.log(`\nCrosswalk written to ${OUTPUT_PATH}`);
  console.log(`  ${pcodeByName.size} admin1 units with a P-code, derived from your own data.`);
  if (unmatched.length > 0) {
    console.log(
      `  ⚠ ${unmatched.length} name(s) from plain-name sources had no matching P-code and are ` +
        `marked needs_review=true:`
    );
    unmatched.forEach((n) => console.log(`     - ${n}`));
    console.log(
      `  Fill these in by hand in ${OUTPUT_PATH} using an authoritative source ` +
        `(search HDX for "Sudan COD-AB" administrative boundaries) — don't guess.`
    );
  } else {
    console.log(`  All plain-name locations matched a P-code automatically.`);
  }
  console.log(`\nNow run "npm run build-catalog" again so this file becomes a queryable source.`);
}

main();
