import { spawn } from "node:child_process";
import readline from "node:readline";
import net from "node:net";
import { z } from "zod";

type Timer = NodeJS.Timeout;

const Handshake = z.object({ serverInfo: z.object({ name: z.string() }) });
const ToolList = z.object({ tools: z.array(z.object({ name: z.string() })) });
const ToolResult = z.object({
  content: z.array(z.object({ text: z.string() })).min(1),
});
const ReadResult = z.object({
  contents: z.array(z.object({ text: z.string() })).min(1),
});
const HttpReply = z.object({
  result: z.unknown(),
  error: z.unknown().optional(),
});

/* Own port: another running figma-inspector instance would otherwise serve this test's reads. */
function freePort(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const found = address && typeof address !== "string" ? address.port : 0;
    probe.close(() => resolve(found));
  });
  return promise;
}

const port = await freePort();

/* FIGMA_INSPECTOR_ENTRY points the same suite at a built/installed copy (e.g. dist/server.js). */
const child = spawn(
  process.execPath,
  [process.env.FIGMA_INSPECTOR_ENTRY || "server.ts"],
  {
    env: {
      ...process.env,
      FIGMA_INSPECTOR_PORT: String(port),
      FIGMA_INSPECTOR_MAX_BYTES: "100000",
    },
  },
);
const rl = readline.createInterface({ input: child.stdout });

type JsonRpcReply = { result: unknown } | { error: unknown };
type Pending = { settle: (reply: JsonRpcReply) => void; timer: Timer };
const pending = new Map<number, Pending>();
let seq = 0;

function send(msg: unknown) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function request(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const id = ++seq;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error("timeout: " + method));
  }, 5000);
  pending.set(id, {
    timer,
    settle: (reply) =>
      "error" in reply
        ? reject(new Error(JSON.stringify(reply.error)))
        : resolve(reply.result),
  });
  send({ jsonrpc: "2.0", id, method, params });
  return promise;
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const parsed: unknown = JSON.parse(line);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("id" in parsed) ||
    typeof parsed.id !== "number"
  )
    return;
  const entry = pending.get(parsed.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(parsed.id);
  entry.settle(
    "error" in parsed
      ? { error: parsed.error }
      : { result: "result" in parsed ? parsed.result : undefined },
  );
});

const assert = (c: unknown, label: string) => {
  if (!c) throw new Error("FAIL: " + label);
  console.log("ok -", label);
};

const start = async () => {
  const init = Handshake.parse(
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    }),
  );
  assert(init.serverInfo.name === "figma-inspector", "initialize handshake");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const names = ToolList.parse(await request("tools/list"))
    .tools.map((t) => t.name)
    .sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["get_ai_prompt", "get_snapshot"]),
    "tools/list exposes both tools",
  );

  const before = ToolResult.parse(
    await request("tools/call", { name: "get_snapshot", arguments: {} }),
  );
  assert(
    before.content[0].text.includes("No snapshot yet"),
    "empty state message",
  );

  const fixture = {
    file: { name: "TestFile" },
    selectionCount: 1,
    totalNodeCount: 1,
    exportedAt: new Date().toISOString(),
    selection: [
      {
        type: "FRAME",
        name: "Hero",
        width: 375,
        height: 600,
        fills: [{ type: "SOLID", color: { r: 0, g: 0.6, b: 1 } }],
      },
    ],
  };
  const push = await fetch("http://127.0.0.1:" + port + "/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: fixture,
      aiText: "[FRAME] Hero (375×600)\n  · fill #0099ff",
    }),
  });
  assert(push.ok, "plugin HTTP push accepted");

  const after = ToolResult.parse(
    await request("tools/call", { name: "get_snapshot", arguments: {} }),
  );
  assert(
    after.content[0].text.includes('"name": "Hero"'),
    "get_snapshot returns pushed data",
  );

  const ai = ToolResult.parse(
    await request("tools/call", { name: "get_ai_prompt", arguments: {} }),
  );
  assert(
    ai.content[0].text.includes("[FRAME] Hero"),
    "get_ai_prompt returns pushed AI text",
  );

  const res = ReadResult.parse(
    await request("resources/read", { uri: "figma://latest/snapshot" }),
  );
  assert(
    res.contents[0].text.includes("Hero"),
    "resource figma://latest/snapshot",
  );

  const res2 = ReadResult.parse(
    await request("resources/read", { uri: "figma://latest/ai-prompt" }),
  );
  assert(
    res2.contents[0].text.includes("[FRAME] Hero"),
    "resource figma://latest/ai-prompt",
  );

  /* MCP over Streamable HTTP, stateless — one JSON-RPC call per POST. */
  let httpSeq = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch("http://127.0.0.1:" + port + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++httpSeq, method, params }),
    });
    assert(res.ok, "MCP HTTP " + method + " accepted");
    const reply = HttpReply.parse(JSON.parse(await res.text()));
    if (reply.error)
      throw new Error(
        "MCP HTTP " + method + " error: " + JSON.stringify(reply.error),
      );
    return reply.result;
  };

  const httpInit = Handshake.parse(
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-test-client", version: "0.0.1" },
    }),
  );
  assert(httpInit.serverInfo.name === "figma-inspector", "MCP HTTP initialize");

  const httpNames = ToolList.parse(await rpc("tools/list"))
    .tools.map((t) => t.name)
    .sort();
  assert(
    JSON.stringify(httpNames) ===
      JSON.stringify(["get_ai_prompt", "get_snapshot"]),
    "MCP HTTP tools/list",
  );

  const httpSnap = ToolResult.parse(
    await rpc("tools/call", { name: "get_snapshot", arguments: {} }),
  );
  assert(
    httpSnap.content[0].text.includes('"name": "Hero"'),
    "MCP HTTP tools/call reads the pushed snapshot",
  );

  const httpAi = ReadResult.parse(
    await rpc("resources/read", { uri: "figma://latest/ai-prompt" }),
  );
  assert(
    httpAi.contents[0].text.includes("[FRAME] Hero"),
    "MCP HTTP resources/read",
  );

  const oversize = await fetch("http://127.0.0.1:" + port + "/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { big: "x".repeat(200000) } }),
  });
  assert(oversize.status === 413, "oversize push rejected with 413");

  const badJson = await fetch("http://127.0.0.1:" + port + "/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert(badJson.status === 400, "malformed push rejected with 400");

  const kept = ToolResult.parse(
    await request("tools/call", { name: "get_snapshot", arguments: {} }),
  );
  assert(
    kept.content[0].text.includes('"name": "Hero"'),
    "rejected pushes leave the stored snapshot intact",
  );

  child.kill("SIGINT");
  console.log("\nALL MCP TESTS PASSED");
};

start().catch((e: Error) => {
  console.error(e.message);
  child.kill("SIGKILL");
  process.exit(1);
});
