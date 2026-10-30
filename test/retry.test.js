const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");
const { requestOpenAI, createServer, createChatHandler } = require("../server");
const http = require("node:http");

// No .env is loaded and every provider request is an explicit stub.
global.fetch = async () => { throw new Error("External network disabled in tests"); };
process.env.OPENAI_API_KEY = "test-only-placeholder-not-a-real-key";
delete process.env.OPENAI_TIMEOUT_MS;
delete process.env.OPENAI_ATTEMPT_TIMEOUT_MS;
delete process.env.CHAT_ENABLED;
const messages = [{ role: "user", content: "Цена поддержки?" }];
const ok = () => new Response(JSON.stringify({ status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text: "Ответ" }] },
] }));
const failure = (status, code, headers = {}, type) => new Response(JSON.stringify({
  error: { code, type, message: "sensitive-provider-message" },
}), { status, headers });
const networkError = (code = "ECONNRESET") => new TypeError("fetch failed", {
  cause: { code, message: "sensitive-network-message" },
});
function clock(random = 0.5) {
  let time = 0;
  const delays = [];
  return { delays, advance: (ms) => { time += ms; }, options: {
    now: () => time, wallNow: () => Date.UTC(2026, 0, 1), random: () => random,
    sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); time += ms; },
  } };
}

test("fifth attempt succeeds with exponential backoff and jitter", async () => {
  const c = clock();
  let calls = 0;
  let statuses = 0;
  const signals = [];
  const result = await requestOpenAI(messages, async (_url, { signal, body }) => {
    signals.push(signal);
    assert.equal(JSON.parse(body).max_output_tokens, 1200);
    if (++calls < 5) throw networkError();
    return ok();
  }, undefined, { ...c.options, onRetry: () => statuses++ });
  assert.equal(result, "Ответ");
  assert.equal(calls, 5);
  assert.equal(statuses, 4);
  assert.deepEqual(c.delays, [1050, 2050, 4050, 8050]);
  assert.equal(new Set(signals).size, 5);
});

test("sixth attempt is never made", async () => {
  const c = clock(0);
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => { calls++; throw networkError(); }, undefined, c.options));
  assert.equal(calls, 5);
  assert.deepEqual(c.delays, [1000, 2000, 4000, 8000]);
});

test("hung attempts time out individually and fifth attempt can succeed", async (t) => {
  process.env.OPENAI_ATTEMPT_TIMEOUT_MS = "20";
  t.after(() => { delete process.env.OPENAI_ATTEMPT_TIMEOUT_MS; });
  const c = clock(0);
  let calls = 0;
  const signals = [];
  const result = await requestOpenAI(messages, async (_url, { signal }) => {
    signals.push(signal);
    if (++calls === 5) return ok();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, undefined, c.options);
  assert.equal(result, "Ответ");
  assert.equal(calls, 5);
  assert.ok(signals.slice(0, 4).every((signal) => signal.aborted));
  assert.equal(signals[4].aborted, false);
  assert.deepEqual(c.delays, [1000, 2000, 4000, 8000]);
});

test("successful headers disable attempt timer while model body finishes", async (t) => {
  process.env.OPENAI_ATTEMPT_TIMEOUT_MS = "20";
  t.after(() => { delete process.env.OPENAI_ATTEMPT_TIMEOUT_MS; });
  let calls = 0;
  const result = await requestOpenAI(messages, async (_url, { signal }) => {
    calls++;
    return { ok: true, json: async () => {
      await wait(60);
      assert.equal(signal.aborted, false);
      return ok().json();
    } };
  });
  assert.equal(result, "Ответ");
  assert.equal(calls, 1);
});

test("hung error body is bounded by attempt timer before retry", async (t) => {
  process.env.OPENAI_ATTEMPT_TIMEOUT_MS = "20";
  t.after(() => { delete process.env.OPENAI_ATTEMPT_TIMEOUT_MS; });
  let calls = 0;
  const c = clock();
  const result = await requestOpenAI(messages, async (_url, { signal }) => {
    if (++calls > 1) return ok();
    return { ok: false, status: 503, headers: new Headers(), json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) };
  }, undefined, c.options);
  assert.equal(result, "Ответ");
  assert.equal(calls, 2);
});

test("global timeout during successful model body never causes retry", async (t) => {
  process.env.OPENAI_TIMEOUT_MS = "80";
  process.env.OPENAI_ATTEMPT_TIMEOUT_MS = "20";
  t.after(() => {
    delete process.env.OPENAI_TIMEOUT_MS;
    delete process.env.OPENAI_ATTEMPT_TIMEOUT_MS;
  });
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(requestOpenAI(messages, async (_url, { signal }) => {
      calls++;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) };
    }), { name: "TimeoutError" });
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});

test("eligible HTTP statuses retry successfully", async (t) => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const c = clock();
      assert.equal(await requestOpenAI(messages, async () => ++calls === 1
        ? failure(status, status === 429 ? "rate_limit_exceeded" : "server_error") : ok(), undefined, c.options), "Ответ");
      assert.equal(calls, 2);
    });
  }
});

test("permanent HTTP and quota errors are never retried", async (t) => {
  const cases = [
    [400, "invalid_request_error"], [401, "invalid_api_key"], [403, "permission_denied"],
    [404, "model_not_found"], [422, "invalid_parameter"], [501, "not_implemented"],
    [429, "insufficient_quota"], [429, "credit_balance_exhausted"],
    [429, "organization_spend_limit_exceeded"], [429, "organization_usage_limit_exceeded"],
    [429, "unknown_code"], [503, "billing_hard_limit_reached"],
    [429, "rate_limit_exceeded", "insufficient_quota"], [500, "invalid_parameter"],
  ];
  for (const [status, code, type] of cases) {
    await t.test(`${status} ${code} ${type || ""}`, async () => {
      let calls = 0;
      const c = clock();
      await assert.rejects(requestOpenAI(messages, async () => { calls++; return failure(status, code, {}, type); }, undefined, c.options));
      assert.equal(calls, 1);
      assert.deepEqual(c.delays, []);
    });
  }
});

test("unknown and permanent network errors are not retried", async (t) => {
  for (const error of [networkError("CERT_HAS_EXPIRED"), networkError("ENOTFOUND"),
    new TypeError("bad URL"), new DOMException("cancelled", "AbortError"),
    new DOMException("timed out", "TimeoutError")]) {
    await t.test(error.name + (error.cause?.code || error.message), async () => {
      let calls = 0;
      await assert.rejects(requestOpenAI(messages, async () => { calls++; throw error; }, undefined, clock().options));
      assert.equal(calls, 1);
    });
  }
});

test("Retry-After delta and HTTP-date apply to 429 and 503", async (t) => {
  for (const status of [429, 503]) {
    for (const header of ["4", "Thu, 01 Jan 2026 00:00:04 GMT"]) {
      await t.test(`${status} ${header}`, async () => {
        const c = clock();
        let calls = 0;
        await requestOpenAI(messages, async () => ++calls === 1
          ? failure(status, "rate_limit_exceeded", { "Retry-After": header }) : ok(), undefined, c.options);
        assert.deepEqual(c.delays, [4000]);
      });
    }
  }
});

test("Retry-After outside budget stops without shortening the delay", async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => {
    calls++; return failure(503, "server_error", { "Retry-After": "120" });
  }, undefined, c.options));
  assert.equal(calls, 1);
  assert.deepEqual(c.delays, []);
});

test("invalid or short Retry-After keeps the exponential minimum", async (t) => {
  for (const header of ["-1", "invalid", "0", "Wed, 31 Dec 2025 23:59:00 GMT"]) {
    await t.test(header, async () => {
      const c = clock();
      let calls = 0;
      await requestOpenAI(messages, async () => ++calls === 1
        ? failure(503, "server_error", { "Retry-After": header }) : ok(), undefined, c.options);
      assert.deepEqual(c.delays, [1050]);
    });
  }
});

test("successful response body failure after partial content never retries", async () => {
  let calls = 0;
  const c = clock();
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"output":[{"type":"message"'));
    queueMicrotask(() => controller.error(networkError()));
  } });
  await assert.rejects(requestOpenAI(messages, async () => { calls++; return new Response(stream); }, undefined, c.options));
  assert.equal(calls, 1);
  assert.deepEqual(c.delays, []);
});

test("incomplete model response never retries", async () => {
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => {
    calls++;
    return new Response('{"status":"incomplete","output":[]}');
  }, undefined, clock().options));
  assert.equal(calls, 1);
});

test("90 second budget includes attempts and backoff and cannot be raised", async (t) => {
  process.env.OPENAI_TIMEOUT_MS = "180000";
  t.after(() => { delete process.env.OPENAI_TIMEOUT_MS; });
  const c = clock(0);
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => {
    calls++;
    c.advance(calls === 1 ? 80000 : 9000);
    throw networkError();
  }, undefined, c.options), { name: "TimeoutError" });
  assert.equal(calls, 2);
  assert.deepEqual(c.delays, [1000]);
});

test("real overall timer spans retry delay and second attempt", async (t) => {
  process.env.OPENAI_TIMEOUT_MS = "1200";
  t.after(() => { delete process.env.OPENAI_TIMEOUT_MS; });
  let calls = 0;
  const signals = [];
  const start = performance.now();
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    await assert.rejects(requestOpenAI(messages, async (_url, { signal }) => {
      signals.push(signal);
      if (++calls === 1) { await wait(20); throw networkError(); }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, undefined, { random: () => 0 }), { name: "TimeoutError" });
    assert.equal(calls, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.ok(performance.now() - start < 2500);
  } finally { clearTimeout(keepAlive); }
});

test("cancellation during backoff prevents another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => { calls++; throw networkError(); }, controller.signal, {
    onRetry: () => setTimeout(() => controller.abort(), 10),
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("pre-cancelled request never calls provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(requestOpenAI(messages, async () => { calls++; return ok(); }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("NDJSON emits retrying then reply without provider details", async (t) => {
  let calls = 0;
  const handler = createChatHandler({ fetchImplementation: async () => ++calls === 1 ? failure(503, "server_error") : ok() });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const text = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/api/chat",
      method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ messages }));
  });
  const events = text.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events, [{ type: "status", status: "retrying" }, { type: "reply", reply: "Ответ" }]);
  assert.equal(calls, 2);
  assert.doesNotMatch(text, /sensitive|test-only/);
});
