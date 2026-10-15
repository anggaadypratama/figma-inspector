#!/usr/bin/env node

// server.ts
import http from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getRequestListener } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
var PORT = Number(process.env.FIGMA_INSPECTOR_PORT || 8790);
var MAX_BODY = Number(process.env.FIGMA_INSPECTOR_MAX_BYTES || 200000000);
var store = {
  data: null,
  aiText: null,
  receivedAt: null
};
function asSnapshot(value) {
  if (!value || typeof value !== "object")
    return { data: null, aiText: null };
  const data = "data" in value ? value.data ?? null : null;
  const aiText = "aiText" in value && typeof value.aiText === "string" ? value.aiText : null;
  return { data, aiText };
}
async function current() {
  if (store.data)
    return store;
  try {
    const res = await fetch("http://127.0.0.1:" + PORT + "/latest", {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok)
      return store;
    const remote = asSnapshot(await res.json());
    if (remote.data)
      return remote;
  } catch {}
  return store;
}
function buildServer() {
  const mcp = new McpServer({ name: "figma-inspector", version: "0.1.0" });
  mcp.tool("get_snapshot", "Latest Figma selection pushed by the Figma Inspector plugin: raw JSON with every node property (parent -> children, recursively), plus styles/variables/components maps.", async () => {
    const snap = await current();
    const text = snap.data ? JSON.stringify(snap.data, null, 2) : "No snapshot yet — select nodes in Figma and open the Figma Inspector plugin (or press Refresh).";
    return { content: [{ type: "text", text }] };
  });
  mcp.tool("get_ai_prompt", "Semantic AI-readable description of the latest Figma selection: layout (flex/padding/gap), colors as hex, fonts, text content, sibling spacing.", async () => {
    const snap = await current();
    const text = snap.aiText ? snap.aiText : snap.data ? "Snapshot exists but no AI prompt was pushed." : "No snapshot yet — select nodes in Figma and open the Figma Inspector plugin.";
    return { content: [{ type: "text", text }] };
  });
  mcp.resource("latest-snapshot", "figma://latest/snapshot", async () => {
    const snap = await current();
    return {
      contents: [
        {
          uri: "figma://latest/snapshot",
          text: JSON.stringify(snap.data ?? {})
        }
      ]
    };
  });
  mcp.resource("latest-ai-prompt", "figma://latest/ai-prompt", async () => {
    const snap = await current();
    return {
      contents: [{ uri: "figma://latest/ai-prompt", text: snap.aiText ?? "" }]
    };
  });
  return mcp;
}
var app = new Hono;
app.use("*", cors({ allowMethods: ["POST", "GET", "OPTIONS"] }));
app.use("/snapshot", bodyLimit({
  maxSize: MAX_BODY,
  onError: (c) => c.json({ ok: false, error: "snapshot too large: " + MAX_BODY + " bytes" }, 413)
}));
app.post("/snapshot", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 400);
  }
  const pushed = asSnapshot(body);
  store.data = pushed.data;
  store.aiText = pushed.aiText;
  store.receivedAt = new Date().toISOString();
  return c.json({ ok: true, receivedAt: store.receivedAt });
});
app.get("/health", (c) => c.json({ ok: true, port: PORT, hasSnapshot: !!store.data }));
app.get("/latest", (c) => c.json({
  ok: true,
  data: store.data,
  aiText: store.aiText,
  receivedAt: store.receivedAt
}));
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true
  });
  await buildServer().connect(transport);
  return transport.handleRequest(c.req.raw);
});
app.notFound((c) => c.text("not found", 404));
var h = http.createServer(getRequestListener(app.fetch));
h.on("error", (e) => {
  process.stderr.write("[figma-inspector-mcp] HTTP listen on :" + PORT + " failed (" + e.code + `) — another figma-inspector instance owns the port; the plugin pushes there and this session reads from it
`);
});
h.listen(PORT, "127.0.0.1", () => {
  process.stderr.write("[figma-inspector-mcp] HTTP on http://127.0.0.1:" + PORT + `/snapshot — Figma plugin pushes here
`);
  process.stderr.write("[figma-inspector-mcp] MCP on http://127.0.0.1:" + PORT + `/mcp (streamable HTTP)
`);
  process.stderr.write(`[figma-inspector-mcp] MCP stdio ready
`);
});
var transport = new StdioServerTransport;
await buildServer().connect(transport);
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
