const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const greeting = html.match(/<div class="bubble">([^<]+)<\/div>/)[1];
const ERROR = "Сейчас не удалось получить ответ. Пожалуйста, попробуйте ещё раз.";

// Only the DOM operations used by the real script; no browser or network needed.
class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.attributes = {};
    this.style = {};
    this.listeners = new Map();
    this.value = "";
    this.disabled = false;
    this.scrollHeight = 44;
    this.scrolls = [];
    this.focusCount = 0;
    this.ownText = "";
  }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.ownText = value; }
  get classList() {
    return { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
  }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.ownText = "";
    this.append(...children);
  }
  cloneNode(deep) {
    const clone = new Element(this.tagName);
    clone.className = this.className;
    clone.attributes = { ...this.attributes };
    clone.ownText = this.ownText;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name, properties = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...properties };
    return this.listeners.get(name)?.(event);
  }
  scrollTo(options) { this.scrolls.push(options); }
  focus() { this.focusCount++; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reply = (text = "Ответ") => new Response(JSON.stringify({ type: "reply", reply: text }) + "\n");

function setup() {
  const elements = Object.fromEntries(["chat-form", "message-input", "send-button", "messages",
    "new-conversation-button"].map((id) => [`#${id}`, new Element()]));
  const messages = elements["#messages"];
  const initial = new Element("article");
  initial.className = "message assistant-message";
  const bubble = new Element();
  bubble.className = "bubble";
  bubble.textContent = greeting;
  initial.append(bubble);
  messages.append(initial);
  const calls = [];
  const logs = [];
  const context = vm.createContext({
    document: { querySelector: (selector) => elements[selector], createElement: (tag) => new Element(tag) },
    AbortController, TextDecoder,
    console: { error: (...args) => logs.push(args) },
    // Intentionally ignores abort: stale results must be harmless even then.
    fetch: (url, options) => {
      const pending = deferred();
      calls.push({ url, ...options, ...pending, payload: JSON.parse(options.body) });
      return pending.promise;
    },
  });
  vm.runInContext(source, context, { filename: "public/app.js" });
  const input = elements["#message-input"];
  const send = elements["#send-button"];
  const button = elements["#new-conversation-button"];
  return {
    messages, input, send, button, calls, logs, initial, form: elements["#chat-form"],
    reset: () => button.emit("click"),
    submit(text) { input.value = text; return elements["#chat-form"].emit("submit"); },
    history: () => JSON.parse(vm.runInContext("JSON.stringify(conversation)", context)),
  };
}

function assertReady(app) {
  assert.equal(app.input.disabled, false);
  assert.equal(app.send.disabled, false);
  assert.equal(app.send.attributes["aria-busy"], "false");
}

test("button is a non-submit action in the topbar; reset restores exactly one greeting", async () => {
  assert.match(html, /<header class="topbar">[\s\S]*<button[^>]*id="new-conversation-button"[^>]*type="button"[^>]*>Новый диалог<\/button>[\s\S]*<\/header>/);
  const app = setup();
  const pending = app.submit("Старый вопрос");
  app.calls[0].resolve(reply("Старый ответ"));
  await pending;
  assert.equal(app.history().length, 2);
  assert.equal(app.messages.children.length, 3);
  app.input.value = "Черновик";
  app.input.style.height = "132px";
  const focusBefore = app.input.focusCount;
  app.reset();
  assert.deepEqual(app.history(), []);
  assert.equal(app.messages.children.length, 1);
  assert.equal(app.messages.textContent, greeting);
  assert.notEqual(app.messages.firstElementChild, app.initial);
  assert.equal(app.input.value, "");
  assert.equal(app.input.style.height, "44px");
  assert.equal(app.input.focusCount, focusBefore + 1);
  assert.equal(app.messages.scrolls.at(-1).top, 0);
  assertReady(app);
});

test("first request after reset contains only the new question", async () => {
  const app = setup();
  const old = app.submit("Старый вопрос");
  app.calls[0].resolve(reply("Старый ответ"));
  await old;
  app.reset();
  const next = app.submit("Новый вопрос");
  assert.deepEqual(app.calls[1].payload, { messages: [{ role: "user", content: "Новый вопрос" }] });
  assert.equal(app.calls[1].url, "/api/chat");
  assert.equal(app.calls[1].method, "POST");
  app.calls[1].resolve(reply());
  await next;
});

test("reset aborts pending fetch and allows immediate submission; stale response cannot unlock it", async () => {
  const app = setup();
  const old = app.submit("Старый");
  assert.equal(app.button.disabled, false);
  app.reset();
  assert.equal(app.calls[0].signal.aborted, true);
  assertReady(app);
  const next = app.submit("Новый");
  const focusBefore = app.input.focusCount;
  const response = reply("Запоздавший ответ");
  app.calls[0].resolve(response);
  await old;
  assert.equal(response.bodyUsed, true); // unused stale body was cancelled
  assert.equal(app.input.disabled, true);
  assert.equal(app.send.attributes["aria-busy"], "true");
  assert.equal(app.input.focusCount, focusBefore);
  assert.doesNotMatch(app.messages.textContent, /Запоздавший/);
  assert.deepEqual(app.history(), [{ role: "user", content: "Новый" }]);
  // The old finally must not clear the new controller either.
  app.reset();
  assert.equal(app.calls[1].signal.aborted, true);
  app.calls[1].resolve(reply());
  await next;
});

test("late rejection of old fetch cannot add an error or change the next request", async () => {
  const app = setup();
  const old = app.submit("Старый");
  app.reset();
  const next = app.submit("Новый");
  app.calls[0].reject(new Error("late network failure"));
  await old;
  assert.equal(app.logs.length, 0);
  assert.doesNotMatch(app.messages.textContent, /не удалось/);
  assert.equal(app.send.disabled, true);
  app.calls[1].resolve(reply("Новый ответ"));
  await next;
  assertReady(app);
  assert.deepEqual(app.history(), [{ role: "user", content: "Новый" }, { role: "assistant", content: "Новый ответ" }]);
});

// Deliberately non-cooperative reader: cancel is recorded, but data can arrive late.
function controlledStream() {
  const reads = [];
  let cancellations = 0, releases = 0;
  const reader = {
    read() { const read = deferred(); reads.push(read); return read.promise; },
    cancel() { cancellations++; return Promise.resolve(); },
    releaseLock() { releases++; },
  };
  return {
    response: { ok: true, body: { getReader: () => reader } }, reads,
    get cancellations() { return cancellations; },
    get releases() { return releases; },
    deliver(events, done = false) {
      const read = reads.shift();
      assert.ok(read, "script must already be awaiting a stream read");
      read.resolve({ value: new TextEncoder().encode(events.map(JSON.stringify).join("\n") + "\n"), done });
    },
  };
}

test("reset during streaming ignores late retry/reply/error and releases reader", async () => {
  const app = setup();
  const old = app.submit("Старый");
  const stream = controlledStream();
  app.calls[0].resolve(stream.response);
  await tick();
  stream.deliver([{ type: "status", status: "retrying" }]);
  await tick();
  assert.match(app.messages.textContent, /Связь нестабильна/);
  app.reset();
  assert.equal(stream.cancellations, 1);
  assert.equal(app.messages.textContent, greeting);
  const next = app.submit("Новый");
  const textBefore = app.messages.textContent;
  const scrollBefore = app.messages.scrolls.length;
  stream.deliver([
    { type: "status", status: "retrying" },
    { type: "reply", reply: "Старый ответ" },
    { type: "error", error: "Старая ошибка" },
  ], true);
  await old;
  assert.equal(stream.releases, 1);
  assert.equal(app.messages.textContent, textBefore);
  assert.equal(app.messages.scrolls.length, scrollBefore);
  assert.equal(app.logs.length, 0);
  assert.equal(app.send.disabled, true);
  app.calls[1].resolve(reply());
  await next;
});

test("reply received before reset but stream completed afterwards cannot restore old context", async () => {
  const app = setup();
  const old = app.submit("Старый");
  const stream = controlledStream();
  app.calls[0].resolve(stream.response);
  await tick();
  stream.deliver([{ type: "reply", reply: "Старый ответ" }]);
  await tick();
  app.reset();
  stream.deliver([], true);
  await old;
  assert.equal(app.messages.textContent, greeting);
  assert.deepEqual(app.history(), []);
  assertReady(app);
});

test("repeated reset is safe, does not fetch and does not duplicate greeting", async () => {
  const app = setup();
  app.reset();
  app.reset();
  assert.equal(app.calls.length, 0);
  const old = app.submit("Вопрос");
  app.reset();
  app.reset();
  app.reset();
  app.calls[0].reject(new DOMException("Cancelled", "AbortError"));
  await old;
  assert.equal(app.calls.length, 1);
  assert.equal(app.messages.children.length, 1);
  assert.equal(app.messages.textContent, greeting);
  assert.deepEqual(app.history(), []);
  assertReady(app);
});

test("normal submission preserves history, trims input and blocks duplicate/blank sends", async () => {
  const app = setup();
  await app.submit("   ");
  assert.equal(app.calls.length, 0);
  const pending = app.submit("  Вопрос  ");
  assert.equal(app.input.value, "");
  assert.equal(app.send.disabled, true);
  await app.submit("Дубликат");
  assert.equal(app.calls.length, 1);
  app.calls[0].resolve(reply("**Ответ**"));
  await pending;
  assert.match(app.messages.textContent, /Вопрос/);
  assert.match(app.messages.textContent, /Ответ/);
  assert.doesNotMatch(app.messages.textContent, /\*\*|Получаю ответ/);
  assertReady(app);
  const next = app.submit("Уточнение");
  assert.deepEqual(app.calls[1].payload.messages, [
    { role: "user", content: "Вопрос" }, { role: "assistant", content: "**Ответ**" },
    { role: "user", content: "Уточнение" },
  ]);
  app.calls[1].resolve(reply());
  await next;
});

test("HTTP, network, NDJSON and malformed-response errors remain visible and can be cleared", async (t) => {
  for (const mode of ["HTTP", "network", "NDJSON", "malformed", "empty"]) {
    await t.test(mode, async () => {
      const app = setup();
      const pending = app.submit("Вопрос");
      if (mode === "network") app.calls[0].reject(new Error("offline"));
      else if (mode === "HTTP") app.calls[0].resolve(new Response("{}", { status: 503 }));
      else if (mode === "NDJSON") app.calls[0].resolve(new Response('{"type":"error","error":"Provider failed"}\n'));
      else if (mode === "malformed") app.calls[0].resolve(new Response("not-json\n"));
      else app.calls[0].resolve(new Response(""));
      await pending;
      assert.equal(app.messages.children.at(-1).className.includes("error-message"), true);
      assert.ok(app.messages.textContent.includes(ERROR));
      assert.doesNotMatch(app.messages.textContent, /Получаю ответ/);
      assert.equal(app.history().length, 1);
      assertReady(app);
      app.reset();
      assert.equal(app.messages.textContent, greeting);
      assert.deepEqual(app.history(), []);
    });
  }
});

test("Enter submits, Shift+Enter does not, and resize remains bounded", async () => {
  const app = setup();
  let submits = 0;
  // requestSubmit is a browser API; invoke the registered real submit handler.
  const original = app.submit.bind(app);
  let pending;
  app.input.scrollHeight = 200;
  app.input.emit("input");
  assert.equal(app.input.style.height, "132px");
  app.form.requestSubmit = () => { submits++; pending = original("С клавиатуры"); };
  app.input.emit("keydown", { key: "Enter", shiftKey: true });
  assert.equal(submits, 0);
  app.input.emit("keydown", { key: "Enter", shiftKey: false });
  assert.equal(submits, 1);
  app.calls[0].resolve(reply());
  await pending;
});
