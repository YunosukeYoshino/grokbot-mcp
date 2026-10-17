#!/usr/bin/env bun
// Verification scaffolding. Accepts the Worker webhook on loopback and does not forward it.
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.STUB_PORT || "8799");
const logPath = process.env.HITS_PATH;
if (!logPath) {
  console.error("HITS_PATH is required");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const rec = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    host: req.headers.host ?? "",
    authorization_present: Boolean(req.headers.authorization),
    body,
  };
  fs.appendFileSync(logPath, JSON.stringify(rec) + "\n");
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub_not_found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`webhook stub ready on http://127.0.0.1:${port}/webhook`);
});
