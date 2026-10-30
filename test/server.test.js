const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer, createChatHandler, sanitizeMessages, requestOpenAI } = require("../server");

// This test process never loads .env and cannot contact a provider via fetch.
const realFetch = global.fetch;
global.fetch = async () => { throw new Error("External network disabled in tests"); };
process.env.OPENAI_API_KEY = "test-only-placeholder-not-a-real-key";
delete process.env.VERCEL;
delete process.env.CHAT_ENABLED;
after(() => { global.fetch = realFetch; });
const messages = [{ role: "user", content: "Сколько стоит Remote Support?" }];
const payload = JSON.stringify({ messages });
const answer = () => new Response(JSON.stringify({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "3 000 ₽ за обращение." }] }],
}), { headers: { "Content-Type": "application/json" } });

async function withServer(t, handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  function request({ path = "/api/chat", method = "POST", body = payload, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method,
        headers: { "Content-Type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  await run(request, port);
}

test("local assets and private paths", async (t) => {
  await withServer(t, createChatHandler(), async (request) => {
    for (const path of ["/", "/app.js", "/styles.css", "/favicon.svg"]) {
      assert.equal((await request({ path, method: "GET", body: "" })).status, 200);
    }
    for (const path of ["/.env", "/server.js", "/ServicePilot_Support_Lite_SUBMIT.zip"]) {
      assert.equal((await request({ path, method: "GET", body: "" })).status, 404);
    }
  });
});

test("successful NDJSON and bounded provider request", async (t) => {
  let calls = 0;
  const handler = createChatHandler({ fetchImplementation: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.max_output_tokens, 1200);
    assert.equal(body.store, false);
    assert.deepEqual(body.input, messages);
    assert.ok(body.instructions.includes("ServicePilot"));
    return answer();
  } });
  await withServer(t, handler, async (request) => {
    const res = await request();
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/x-ndjson/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(res.text).type, "reply");
    assert.ok(res.text.endsWith("\n"));
    assert.equal(calls, 1);
  });
});

test("invalid input never calls provider", async (t) => {
  let calls = 0;
  const handler = createChatHandler({ fetchImplementation: async () => { calls++; return answer(); } });
  await withServer(t, handler, async (request) => {
    for (const body of ["{", "null", "{}", JSON.stringify({ messages: [{ role: "system", content: "bad" }] })]) {
      assert.equal((await request({ body })).status, 400);
    }
    assert.equal((await request({ body: "x".repeat(100001) })).status, 413);
    assert.equal(calls, 0);
  });
});

test("method, media type and origin rejected", async (t) => {
  await withServer(t, createChatHandler(), async (request) => {
    assert.equal((await request({ method: "GET", body: "" })).status, 405);
    assert.equal((await request({ headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await request({ headers: { Origin: "https://elsewhere.example" } })).status, 403);
  });
});

test("history has bounded count and aggregate size", () => {
  assert.equal(sanitizeMessages(Array(30).fill(messages[0])).length, 24);
  assert.equal(sanitizeMessages([{ role: "user", content: "a".repeat(4001) }]), null);
  assert.equal(sanitizeMessages(Array(5).fill({ role: "user", content: "a".repeat(4000) })), null);
});

test("per-client rate limit and recovery", async (t) => {
  let time = 100000;
  let calls = 0;
  const handler = createChatHandler({ now: () => time, fetchImplementation: async () => { calls++; return answer(); } });
  await withServer(t, handler, async (request) => {
    for (let i = 0; i < 6; i++) assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal(calls, 6);
    time += 60000;
    assert.equal((await request()).status, 200);
  });
});

test("per-process total rate limit across Vercel IPs", async (t) => {
  process.env.VERCEL = "1";
  t.after(() => { delete process.env.VERCEL; });
  await withServer(t, createChatHandler({ fetchImplementation: async () => answer() }), async (request) => {
    for (let i = 0; i < 30; i++) {
      assert.equal((await request({ headers: { "x-vercel-forwarded-for": `192.0.2.${i}` } })).status, 200);
    }
    assert.equal((await request({ headers: { "x-vercel-forwarded-for": "192.0.2.99" } })).status, 429);
  });
});

test("concurrency limit releases its slot", async (t) => {
  const pending = [];
  const handler = createChatHandler({ fetchImplementation: () => new Promise((resolve) => pending.push(resolve)) });
  await withServer(t, handler, async (request) => {
    const first = request();
    const second = request();
    while (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await request()).status, 429);
    pending.splice(0).forEach((resolve) => resolve(answer()));
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    const next = request();
    while (!pending.length) await new Promise((resolve) => setTimeout(resolve, 5));
    pending.shift()(answer());
    assert.equal((await next).status, 200);
  });
});

test("provider failure: generic NDJSON, safe logs, no retries", async (t) => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  t.after(() => { console.error = original; });
  let calls = 0;
  await withServer(t, createChatHandler({ fetchImplementation: async () => {
    calls++;
    throw new Error("sensitive-provider-text " + process.env.OPENAI_API_KEY, { cause: "sensitive-cause" });
  } }), async (request) => {
    const res = await request();
    assert.equal(JSON.parse(res.text).type, "error");
    assert.equal(calls, 1);
    assert.equal(logs.join("\n"), "[chat] request_failed");
    assert.doesNotMatch(res.text, /sensitive|test-only/);
  });
});

test("provider HTTP errors, empty and truncated answers rejected", async () => {
  for (const response of [new Response('{"error":{"message":"sensitive"}}', { status: 401 }),
    new Response('{}'), new Response('{"status":"incomplete","output":[]}')]) {
    await assert.rejects(requestOpenAI(messages, async () => response));
  }
});

test("timeout aborts the mock provider", async (t) => {
  process.env.OPENAI_TIMEOUT_MS = "20";
  t.after(() => { delete process.env.OPENAI_TIMEOUT_MS; });
  // Keeps the process alive while AbortSignal.timeout's unref'ed timer runs.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(requestOpenAI(messages, async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })), { name: "TimeoutError" });
  } finally { clearTimeout(keepAlive); }
});

test("kill switch and missing configuration never call provider", async (t) => {
  let calls = 0;
  const stub = async () => { calls++; return answer(); };
  process.env.CHAT_ENABLED = "false";
  try {
    await withServer(t, createChatHandler({ fetchImplementation: stub }), async (request) => {
      assert.equal((await request()).status, 503);
    });
  } finally { delete process.env.CHAT_ENABLED; }
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try { await assert.rejects(requestOpenAI(messages, stub)); }
  finally { process.env.OPENAI_API_KEY = key; }
  assert.equal(calls, 0);
});

test("Vercel export accepts pre-parsed JSON body", async (t) => {
  global.fetch = async () => answer();
  t.after(() => { global.fetch = async () => { throw new Error("External network disabled in tests"); }; });
  const handler = require("../api/chat");
  await withServer(t, (req, res) => { req.body = { messages }; return handler(req, res); }, async (request) => {
    assert.equal(JSON.parse((await request()).text).type, "reply");
  });
});

test("client disconnect cancels the mock provider", async (t) => {
  let started;
  let cancelled;
  const ready = new Promise((resolve) => { started = resolve; });
  const aborted = new Promise((resolve) => { cancelled = resolve; });
  const handler = createChatHandler({ fetchImplementation: async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled(); reject(signal.reason); }, { once: true });
    });
  } });
  await withServer(t, handler, async (_request, port) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST",
      headers: { "Content-Type": "application/json" } });
    req.on("error", () => {});
    req.end(payload);
    await ready;
    req.destroy();
    await aborted;
  });
});

test("unchanged npm start entrypoint starts locally", async (t) => {
  const script = JSON.parse(fs.readFileSync("package.json")).scripts.start;
  assert.equal(script, "node --env-file-if-exists=.env server.js");
  // Execute the exact Node command used by npm start; no npm installation needed.
  const child = spawn(process.execPath, script.split(" ").slice(1), {
    env: { ...process.env, PORT: "31987", CHAT_ENABLED: "false" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local start timeout")), 5000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("http://127.0.0.1:31987")) { clearTimeout(timer); resolve(); }
    });
  });
  await new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:31987/", (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
});

test("Vercel cancellation reaches provider and releases handlers", async (t) => {
  for (const mode of ["error", "signal", "already-aborted"]) {
    await t.test(mode, { timeout: 3000 }, async (t) => {
      const cancellation = new AbortController();
      if (mode === "already-aborted") cancellation.abort();
      let incoming;
      let calls = 0;
      let providerSignal;
      let started;
      const ready = new Promise((resolve) => { started = resolve; });
      const handler = createChatHandler({ fetchImplementation: async (_url, { signal }) => {
        calls++;
        if (calls > 1) return answer();
        providerSignal = signal;
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } });
      await withServer(t, (req, res) => {
        incoming = req;
        req.body = { messages };
        // Node 24 exposes a getter-only signal; explicitly override it in this mock.
        Object.defineProperty(req, "signal", { value: cancellation.signal });
        return handler(req, res);
      }, async (request) => {
        const pending = request();
        if (mode !== "already-aborted") {
          await ready;
          if (mode === "error") incoming.emit("error", new Error("aborted"));
          else cancellation.abort();
        }
        assert.equal((await pending).text, "");
        assert.equal(incoming.listenerCount("error"), 0);
        if (mode === "already-aborted") assert.equal(calls, 0);
        else assert.equal(providerSignal.aborted, true);
      });
    });
  }
});

test("interrupted upload is handled without a provider call", async (t) => {
  let calls = 0;
  const handler = createChatHandler({ fetchImplementation: async () => { calls++; return answer(); } });
  await withServer(t, handler, async (request, port) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "100" } });
    req.on("error", () => {});
    req.write('{"messages":');
    await new Promise((resolve) => setTimeout(resolve, 20));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    assert.equal((await request()).status, 200);
    assert.equal(calls, 1);
  });
});

test("deployment configuration exposes only frontend assets", () => {
  const config = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  assert.equal(config.outputDirectory, "public");
  assert.equal(config.functions["api/chat.js"].maxDuration, 120);
  assert.equal(config.functions["api/chat.js"].supportsCancellation, true);
  assert.deepEqual(fs.readdirSync("public").sort(), ["app.js", "favicon.svg", "index.html", "styles.css"]);
  assert.equal(JSON.parse(fs.readFileSync("package.json")).engines.node, "24.x");
});
