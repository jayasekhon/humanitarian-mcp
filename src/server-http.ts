import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const app = express();
app.use(express.json());

// Simple shared-secret auth. Set MCP_API_KEY in your hosting environment.
// Swap this for Entra ID / OAuth once you move past prototyping — the
// Agents Toolkit supports configuring that when you wire up the agent.
const API_KEY = process.env.MCP_API_KEY;

app.use((req, res, next) => {
  if (!API_KEY) return next(); // no key configured = auth disabled (local dev only)
  const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// One transport+server per session, keyed by the MCP session id header.
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    const server = new McpServer({ name: "humanitarian-data", version: "0.1.0" });
    registerTools(server);

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport!),
    });

    transport.onclose = () => {
      if (transport!.sessionId) sessions.delete(transport!.sessionId);
    };

    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Unknown or missing session");
    return;
  }
  await transport.handleRequest(req, res);
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => console.log(`MCP HTTP server listening on :${port}`));
