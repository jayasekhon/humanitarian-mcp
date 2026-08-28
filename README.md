# Humanitarian Data MCP Server — Build Guide

Goal: an MCP server that lets your M365 agent discover which of your Excel/CSV
sources is relevant to a question, inspect its schema, and query/join across
sources with SQL instead of the agent guessing or dumping whole files into
context.

Five tools are exposed:
- `list_data_sources` — catalog of everything available (title, description, columns)
- `get_schema` — column names, types, and sample values for one source
- `query_source` — run a read-only SQL SELECT against one source
- `query_sources` — run a read-only SQL SELECT that JOINS across two or more sources
- `search_data_sources` — keyword search across the catalog

---

## Phase 0 — Prerequisites

- Node.js 20+
- VS Code, stable or Insiders
- The **GitHub Copilot** + **GitHub Copilot Chat** extensions (used to test MCP tools locally before wiring into M365)
- The **Microsoft 365 Agents Toolkit** extension for VS Code
- An Microsoft 365 tenant where you can sideload/test a custom Copilot agent (needs custom app upload enabled — check with your tenant admin if unsure)

---

## Phase 1 — Project setup

1. Unzip/copy this project folder somewhere local.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `data/raw/` and drop your source files in:
   ```bash
   mkdir -p data/raw
   cp ~/Downloads/*.xlsx ~/Downloads/*.csv data/raw/
   ```
   **Rename files first if they have download-artifact suffixes** like
   `__1_`, `__2_` (common when re-downloading the same export). The
   filenames in `data/source-config.json` (Phase 2) must match exactly
   what's in `data/raw/`.

---

## Phase 2 — Build the catalog

```bash
npm run build-catalog
```

This scans `data/raw`, converts every `.xlsx`/`.xls` to CSV under `data/csv`,
profiles each column (inferred type + sample values), and writes
`data/catalog.json`. **Every sheet in a multi-sheet workbook becomes its own
catalog entry** (e.g. `id: "..._jiaf...__cluster_pin"`) — nothing gets
silently dropped.

**Known quirk in your JIAF workbook**: its 3 sheets (`Cluster PIN`,
`Cluster Severity`, `PiN Historical Trend`) each have a **stacked 3-row
header** (a totals row, a group-label row, then the real column names on
row 3). `data/source-config.json` already has overrides telling the builder
to use row 3 (`header_row: 2`, 0-indexed) as the header for those three
sheets — you don't need to do anything for this, just make sure the
filename in `data/raw` matches the one in `source-config.json`. If you add
other messy workbooks later, add an entry there the same way.

**Known quirk in CERF Projects**: the `projectsectors` column contains raw
embedded JSON per row. It'll come through as one (long) text column — fine
for DuckDB to select/filter on as text, but don't expect the model to parse
it structurally without you first widening the catalog description to
explain what's in it, or writing a small extraction step later if you need
to query inside it.

**Do this next — it's the step that actually fixes your original problem:**
open `data/catalog.json` and hand-write the `description` and `keywords` for
every entry. Column names and file names are rarely enough for a model to
correctly guess "this is the one with IDP figures by district" vs "this is
the one with funding flows by donor." A good description is 1–2 sentences:
what the data covers, its geographic/time scope, and what it's *not*. This
is the single highest-leverage thing you can do — better than any code
change — for the agent picking the right source.

Re-run `npm run build-catalog` any time you add or refresh a file; it
preserves your hand-written descriptions by matching on file id.

**Known limitation across your sources — geography doesn't join cleanly.**
Your sources use three different geo identifiers:
- JIAF and IDP Admin 0 use P-codes (`SD13`, `SDN`)
- CERF and VIEWS use ISO3 codes (`SDN`)
- 3W Operational Presence uses **plain state/locality names with no code**
  (`Khartoum`, `Bahri`)

This is handled now with a dedicated crosswalk source and a multi-source
query tool — see Phase 2b below — rather than left as a limitation for the
agent to work around.

---

## Phase 2b — Build the geo crosswalk (enables real cross-source joins)

`query_sources` (below) can join across sources in one SQL query, but only
if they share a key. Run this to derive that shared key from your own data
instead of hand-typing P-codes:

```bash
npm run build-catalog      # first pass, builds catalog.json
npm run build-crosswalk    # derives sudan_geo_crosswalk.csv from JIAF/IDP's
                            # own admin1 name<->P-code columns
npm run build-catalog      # second pass, picks up the new crosswalk as a source
```

The script pulls real (name, P-code) pairs out of your JIAF and IDP files —
it never invents a P-code. It then checks whether 3W's plain state names
match one of those pairs. Read the console output: if it lists any
`needs_review` names, open `data/raw/sudan_geo_crosswalk.csv` and fill in
the P-code by hand from an authoritative source (search HDX for
`Sudan COD-AB`) — don't guess, and don't let the agent guess either.

Once built, `sudan_geo_crosswalk` shows up in `list_data_sources` like any
other source, so the agent can join through it, e.g.: join `3W.State` to
`crosswalk.admin1_name`, then `crosswalk.admin1_pcode` to `jiaf."Admin 1 P-Code"`.

---

## Phase 3 — Test locally in VS Code before touching M365

1. Open the project folder in VS Code.
2. Open **GitHub Copilot Chat**, switch to **Agent mode**.
3. It should auto-detect `.vscode/mcp.json` and offer to start the
   `humanitarian-data` server — click **Start**, then refresh the tools list.
4. Ask it something like: *"What data sources do you have access to?"* — it
   should call `list_data_sources` and describe them back to you using your
   catalog descriptions.
5. Try a real question that spans two sources, e.g. *"Compare total funding
   by country in [source A] against population figures in [source B] for
   the top 5 countries"* — watch it call `get_schema`, then `query_source`
   twice, and reason over the results.

If a query fails, the tool returns the DuckDB error message directly, which
is usually enough to see a column name mismatch — check `get_schema`'s
output against what the model tried.

This step matters: fix catalog descriptions and iterate here, in Copilot
Chat, before you touch the Agents Toolkit — it's a much faster loop than
testing through a deployed Copilot agent.

---

## Phase 4 — Make it reachable for M365 Copilot

Local `stdio` (Phase 3) only works inside VS Code. A real Microsoft 365
Copilot agent needs to reach your server over HTTPS, so it needs to be
hosted somewhere. `src/server-http.ts` implements the same tools over the
MCP **Streamable HTTP** transport with simple bearer-token auth.

### Deploy for free — Azure App Service (Free F1 tier)

Streamable HTTP MCP servers hold session state in memory across requests,
so a long-running process (App Service) is a more reliable free option than
a stateless Functions consumption plan for this use case.

```bash
npm install -g @azure/cli   # if you don't have it
az login
az group create -n humanitarian-mcp-rg -l eastus
az appservice plan create -n humanitarian-mcp-plan -g humanitarian-mcp-rg --sku F1 --is-linux
az webapp create -n <your-unique-app-name> -g humanitarian-mcp-rg -p humanitarian-mcp-plan --runtime "NODE:20-lts"

# Set your auth secret
az webapp config appsettings set -n <your-unique-app-name> -g humanitarian-mcp-rg \
  --settings MCP_API_KEY="<generate-a-long-random-string>"

# Build and deploy
npm run build
az webapp deploy -n <your-unique-app-name> -g humanitarian-mcp-rg --src-path . --type zip
az webapp config set -n <your-unique-app-name> -g humanitarian-mcp-rg --startup-file "npm run start-http"
```

Your MCP endpoint will be:
`https://<your-unique-app-name>.azurewebsites.net/mcp`

Notes:
- F1 free tier spins down on idle and has limited compute — fine for a
  prototype/personal agent, not for production load. Move to B1 (~$13/mo)
  if you need it always-warm.
- `data/csv` and `data/catalog.json` need to be included in the deployed
  package (they will be, if they're in the project root when you zip/deploy).
  For frequently-updated sources, consider deploying to Azure Blob Storage
  and pointing `duckdb-client.ts` at blob URLs instead of local paths —
  DuckDB can `read_csv_auto()` directly from `https://` URLs.
- Keep `MCP_API_KEY` secret — treat the Agents Toolkit's auth config
  (Phase 5) as where that key actually gets supplied at runtime.

---

## Phase 5 — Wire it into a Microsoft 365 declarative agent

1. In VS Code, open the **Microsoft 365 Agents Toolkit** panel.
2. Create a new project → **Declarative Agent**.
3. When asked how to add capabilities, choose **Start with an MCP Server**.
4. Enter your deployed URL: `https://<your-unique-app-name>.azurewebsites.net/mcp`
5. The toolkit will call the server, fetch the five tool definitions, and
   let you select which to include (include all five).
6. Configure authentication — choose the option for a bearer/API key and
   supply the same value as `MCP_API_KEY`. (For anything beyond a personal
   prototype, swap the server's auth for OAuth/Entra — the toolkit's auth
   step supports this, but it's more setup than a prototype needs.)
7. The toolkit generates the declarative agent manifest and API plugin spec
   referencing your MCP tools.
8. In the agent's instructions field, add guidance like: *"Always call
   list_data_sources before answering questions about humanitarian data.
   Use get_schema to confirm column names before writing a query. For a
   question about one source, use query_source. For a question that
   compares or joins two or more sources, use query_sources instead — if
   the sources don't share a location column directly, join through the
   sudan_geo_crosswalk source rather than guessing a match."*

---

## Phase 6 — Test end to end

1. Use the Agents Toolkit's **Preview** / **F5** debug flow to sideload the
   agent into Microsoft 365 Copilot for your account.
2. Ask the same comparison questions you tried in Phase 3.
3. If it's picking the wrong source or writing bad SQL, the fix is almost
   always back in `data/catalog.json` — tighten descriptions/keywords, or
   in the agent instructions — not in the tool code.

---

## Hardening / next steps (optional, once the prototype works)

- **Row/response size limits**: `query_source` caps at 500 rows; lower this
  if responses are still too large for the model to reason over cleanly.
- **Refresh automation**: wrap `npm run build-catalog` + redeploy in a
  scheduled GitHub Action if your source files update regularly.
- **Real auth**: replace the bearer-token check in `server-http.ts` with
  Entra ID token validation once this moves beyond personal/prototype use.
- **Combine with your OCHA FTS repo**: add a second tool set that fetches
  `data/{slug}/latest.json` from `raw.githubusercontent.com` and register
  those alongside the local-file tools — same `McpServer` instance, so the
  agent gets one unified catalog across live API data and your local files.
