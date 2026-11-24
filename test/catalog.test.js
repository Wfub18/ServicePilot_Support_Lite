const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { catalog, buildSystemPrompt } = require("../consultation");
const { SYSTEM_PROMPT, requestOpenAI } = require("../server");

test("catalog v1.0 preserves the supplied package prices, scope and SLA", () => {
  assert.equal(catalog.version, "1.0");
  assert.equal(catalog.date, "2026-08-16");
  assert.deepEqual(catalog.packages.map((p) => [p.name, p.priceRub, p.minimumMonths, p.extraUserRub]), [
    ["ESSENTIAL", 45000, 3, 900], ["BUSINESS", 120000, 6, 800], ["CRITICAL", 260000, 12, 700],
  ]);
  assert.deepEqual(catalog.packages.map((p) => p.users), [
    { min: 20, max: 50 }, { min: 51, max: 150 }, { min: 100, max: 300 },
  ]);
  assert.deepEqual(catalog.packages.map((p) => p.monitoringDevices), [0, 20, 50]);
  for (const p of catalog.packages) assert.equal(Number(p.price.split(" ₽")[0].replaceAll(" ", "")), p.priceRub);
  assert.deepEqual(catalog.packages.map((p) => p.reaction.P1), [
    "до 60 минут в часы поддержки", "до 30 минут в часы поддержки", "до 15 минут",
  ]);
  assert.match(catalog.common.sla, /Гарантированный срок восстановления.*не предусматривают/);
});

function renderCatalog(source) {
  class Element {
    constructor() { this.children = []; this.text = ""; }
    set textContent(value) { this.text = value; }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join("\n"); }
    append(...children) { this.children.push(...children); }
  }
  const nodes = Object.fromEntries(["#catalog-notice", "#catalog-packages", "#catalog-common"].map((id) => [id, new Element()]));
  const context = vm.createContext({ ServicePilotCatalog: source,
    document: { querySelector: (id) => nodes[id], createElement: () => new Element() } });
  vm.runInContext(fs.readFileSync("public/catalog-view.js", "utf8"), context);
  return Object.values(nodes).map((node) => node.textContent).join("\n");
}

test("browser and Node load the same catalog; every displayed condition comes from it", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync("public/catalog.js", "utf8"), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ServicePilotCatalog)), catalog);
  const displayed = renderCatalog(catalog);
  assert.ok(displayed.includes(catalog.notice));
  for (const p of catalog.packages) {
    for (const field of ["name", "price", "eligibility", "support", "visits", "emergency", "monitoring", "reporting", "launch"]) {
      if (p[field]) assert.ok(displayed.includes(p[field]), `${p.name}: ${field}`);
    }
    for (const value of Object.values(p.reaction)) assert.ok(displayed.includes(value));
    assert.ok(displayed.includes(`${p.extraUserRub} ₽/мес.`));
  }
  for (const value of Object.values(catalog.common)) assert.ok(displayed.includes(value));
  assert.ok(SYSTEM_PROMPT.includes(JSON.stringify(catalog, null, 2)));
});

test("changing catalog data updates both UI and prompt without a second price list", () => {
  const changed = structuredClone(catalog);
  changed.packages[0].price = "Учебная контрольная цена";
  changed.packages[0].reaction.P1 = "Контрольная реакция";
  assert.match(renderCatalog(changed), /Учебная контрольная цена/);
  assert.match(renderCatalog(changed), /Контрольная реакция/);
  assert.match(buildSystemPrompt(changed), /Учебная контрольная цена/);
  assert.match(buildSystemPrompt(changed), /Контрольная реакция/);
  const html = fs.readFileSync("public/index.html", "utf8");
  assert.ok(html.indexOf('/catalog.js') < html.indexOf('/catalog-view.js'));
  assert.doesNotMatch(html, /Basic Support|Business Support|3 000 ₽|5 000 ₽|90 000 ₽/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Basic Support|Business Support|Remote Support|On-site Engineer|90 000 ₽/);
});

test("incomplete scenario reaches the provider with separate-user clarification instructions", async () => {
  process.env.OPENAI_API_KEY = "test-only-placeholder-not-a-real-key";
  const history = [{ role: "user", content: "У нас 20 компьютеров и два сервера. Какой пакет выбрать?" }];
  let calls = 0;
  const result = await requestOpenAI(history, async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.input, history);
    assert.ok(body.instructions.includes(JSON.stringify(catalog, null, 2)));
    assert.match(body.instructions, /не сообщает число пользователей/);
    assert.match(body.instructions, /Пока не получены ответы, не выбирай пакет/);
    assert.match(body.instructions, /ТОЛЬКО к мониторингу/);
    return new Response(JSON.stringify({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "Сколько пользователей?" }] },
    ] }));
  });
  assert.equal(calls, 1);
  assert.equal(result, "Сколько пользователей?");
});

test("nonstandard SLA and mixed schedule require individual assessment and an honest chat summary", () => {
  assert.match(SYSTEM_PROMPT, /гарантированное восстановление \(например за два часа\)/);
  assert.match(SYSTEM_PROMPT, /смешанный график для части систем/);
  assert.match(SYSTEM_PROMPT, /Не обещай решить это переходом на CRITICAL/);
  assert.match(SYSTEM_PROMPT, /Резюме для менеджера/);
  assert.match(SYSTEM_PROMPT, /Никогда не говори, что отправил данные/);
  assert.match(catalog.common.individual, /Точный отсчёт реакции вне часов поддержки/);
});
