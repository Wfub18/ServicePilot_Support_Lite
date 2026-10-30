const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_API_ATTEMPTS = 5;
const MAX_OUTPUT_TOKENS = 1_200;
const MAX_TOTAL_MESSAGE_LENGTH = 16_000;
const MAX_BODY_SIZE = 100_000;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 4_000;
const PUBLIC_DIR = path.join(__dirname, "public");
const API_ERROR_MESSAGE =
  "Сейчас не удалось получить ответ. Пожалуйста, попробуйте ещё раз.";

const SYSTEM_PROMPT = `### Роль
Ты — администратор компании ServicePilot Support.

### Данные
Используй только следующие сведения о компании:

1. Remote Support — 3 000 ₽ за одно обращение.
2. On-site Engineer — 5 000 ₽ за один выезд инженера.
3. Basic Support — 45 000 ₽ в месяц.
4. Business Support — 90 000 ₽ в месяц.
5. Стандартные часы работы: понедельник–пятница, 09:00–18:00.
6. Критические обращения приоритета P1 принимаются 24 часа в сутки, 7 дней в неделю.
7. Компания оказывает услуги IT-поддержки организациям.
8. Демонстрационный email для связи: support@servicepilot.google.com.
9. Демонстрационный телефон для связи: +7 (495) 123-45-67.

### Правила
- Отвечай только на вопросы, относящиеся к ServicePilot Support и указанным выше услугам.
- Не отвечай на общие вопросы, не связанные с деятельностью компании.
- Не придумывай цены, условия, услуги, технические возможности или другие сведения, которых нет в данных.
- Отвечай кратко, вежливо и понятно.

### Если не знаешь ответ
Если вопрос относится к ServicePilot Support, но необходимой информации нет в данных, честно сообщи, что такой информации у тебя нет, и предложи уточнить её у сотрудника компании.`;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function startEventStream(response) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.flushHeaders();
}

function sendEvent(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`);
}

class HttpError extends Error {
  constructor(status) {
    super("Request rejected");
    this.status = status;
  }
}

async function readJsonBody(request) {
  // Vercel's Node handler may have already parsed the body.
  if (request.body !== undefined) {
    const raw = typeof request.body === "string" || Buffer.isBuffer(request.body)
      ? request.body.toString() : JSON.stringify(request.body);
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_SIZE) throw new HttpError(413);
    try { return JSON.parse(raw); } catch { throw new HttpError(400); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error, body) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      if (error) {
        // An interrupted upload can emit error after aborted; keep it handled.
        request.once("error", () => {});
        request.resume();
        reject(error);
      } else resolve(body);
    };
    const onData = (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_SIZE) return finish(new HttpError(413));
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { return finish(new HttpError(400)); }
      finish(null, body);
    };
    const onError = () => finish(new HttpError(400));
    const onAborted = () => finish(new HttpError(400));
    const timer = setTimeout(() => finish(new HttpError(408)), 10_000);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function sanitizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const messages = value.slice(-MAX_MESSAGES).map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      return null;
    }

    const content = message.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      return null;
    }

    return { role: message.role, content };
  });

  if (messages.some((message) => message === null) ||
      messages.reduce((total, message) => total + message.content.length, 0) > MAX_TOTAL_MESSAGE_LENGTH) {
    return null;
  }

  return messages;
}

function extractResponseText(data) {
  if (!data || !Array.isArray(data.output)) {
    return "";
  }

  return data.output
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((content) => content?.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);

function isTemporaryNetworkError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return false;
  return RETRYABLE_NETWORK_CODES.has(error?.cause?.code || error?.code);
}

function isRetryableHttpError(status, data) {
  if (!RETRYABLE_STATUS.has(status)) return false;
  const code = data?.error?.code;
  const type = data?.error?.type;
  // Classify only structured codes, never provider messages or headers in logs.
  if ([code, type].some((value) => typeof value === "string" &&
      /quota|billing|credit|spend|usage_limit|invalid|authentication|permission|model_not_found|context_length/.test(value))) {
    return false;
  }
  // Unknown 429s fail closed: do not accidentally retry a new billing error.
  return status !== 429 || code === "rate_limit_exceeded" || code === "slow_down" ||
    type === "rate_limit_error" || type === "rate_limit_exceeded";
}

function retryAfterMs(value, wallNow) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP-date form; reject other values, including negative delta-seconds.
  if (!/^[A-Za-z]{3}, /.test(trimmed)) return 0;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - wallNow()) : 0;
}

async function requestOpenAI(messages, fetchImplementation = fetch, signal, {
  onRetry = () => {},
  sleep = (ms, abortSignal) => wait(ms, undefined, { signal: abortSignal }),
  random = Math.random,
  now = () => performance.now(),
  wallNow = Date.now,
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_api_key_here") throw new Error("API is not configured");
  const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(Math.min(configuredTimeout, DEFAULT_TIMEOUT_MS)) : DEFAULT_TIMEOUT_MS;
  const configuredAttemptTimeout = Number(process.env.OPENAI_ATTEMPT_TIMEOUT_MS);
  const attemptTimeoutMs = Number.isFinite(configuredAttemptTimeout) && configuredAttemptTimeout > 0
    ? Math.floor(Math.min(configuredAttemptTimeout, DEFAULT_ATTEMPT_TIMEOUT_MS)) : DEFAULT_ATTEMPT_TIMEOUT_MS;
  // One deadline and one timeout signal for all attempts, body reads and sleeps.
  const deadline = now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const apiSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const checkBudget = () => {
    apiSignal.throwIfAborted();
    if (now() >= deadline) throw new DOMException("API timeout", "TimeoutError");
  };
  const requestBody = JSON.stringify({
    model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
    instructions: SYSTEM_PROMPT, input: messages, store: false,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
    checkBudget();
    let apiResponse;
    let retryAfter = 0;
    let retryable = false;
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([apiSignal, attemptController.signal]);
    // Bound header/error-body waiting. Once HTTP succeeds, body reading may
    // use the remaining overall budget and must never be retried.
    const attemptTimer = setTimeout(() => {
      attemptController.abort(new DOMException("Attempt timeout", "TimeoutError"));
    }, Math.max(1, Math.min(attemptTimeoutMs, Math.ceil(deadline - now()))));
    try {
      apiResponse = await fetchImplementation("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: requestBody, signal: attemptSignal,
      });
    } catch (error) {
      checkBudget();
      if (!attemptController.signal.aborted && !isTemporaryNetworkError(error)) {
        throw new Error("Provider request failed");
      }
      retryable = true;
    } finally {
      if (!apiResponse || apiResponse.ok || apiSignal.aborted || now() >= deadline) {
        clearTimeout(attemptTimer);
      }
    }
    checkBudget();
    if (apiResponse?.ok) {
      // Never retry after a successful response starts arriving, even if its
      // body is truncated or a network error interrupts JSON parsing.
      const data = await apiResponse.json();
      checkBudget();
      const text = extractResponseText(data);
      if (!text || data.status === "incomplete" || data.status === "failed") {
        throw new Error("Provider returned no complete answer");
      }
      return text;
    }
    if (apiResponse) {
      let data;
      try {
        data = await apiResponse.json().catch(() => null);
      } finally {
        clearTimeout(attemptTimer);
      }
      checkBudget();
      retryable = isRetryableHttpError(apiResponse.status, data);
      if (apiResponse.status === 429 || apiResponse.status === 503) {
        retryAfter = retryAfterMs(apiResponse.headers.get("retry-after"), wallNow);
      }
    }
    if (!retryable || attempt === MAX_API_ATTEMPTS) throw new Error("Provider request failed");
    const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(random() * 100);
    const delayMs = Math.max(backoff, retryAfter);
    // Do not shorten Retry-After to squeeze another request into the budget.
    if (!Number.isFinite(delayMs) || delayMs >= deadline - now()) {
      throw new Error("Provider retry exceeds time budget");
    }
    checkBudget();
    onRetry();
    checkBudget();
    await sleep(delayMs, apiSignal);
  }
}

function createChatHandler({ fetchImplementation = (...args) => fetch(...args), now = Date.now } = {}) {
  // Best effort per process, NOT a distributed spending cap. Use Vercel WAF too.
  const clients = new Map();
  let active = 0;
  let windowStart = 0;
  let requests = 0;
  return async function handleChat(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    if (process.env.CHAT_ENABLED === "false") {
      return sendJson(response, 503, { error: API_ERROR_MESSAGE });
    }
    // Browser cross-site protection; not authentication or a bot defence.
    if (request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host) throw new Error();
      } catch {
        return sendJson(response, 403, { error: "Forbidden" });
      }
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return sendJson(response, 415, { error: "Expected application/json" });
    }
    const time = now();
    for (const [key, value] of clients) {
      if (time - value.start >= 60_000) clients.delete(key);
    }
    // Vercel overwrites x-vercel-forwarded-for. Locally ignore proxy headers.
    const ip = process.env.VERCEL === "1"
      ? String(request.headers["x-vercel-forwarded-for"] || "unknown").split(",")[0].trim()
      : request.socket?.remoteAddress || "local";
    const client = clients.get(ip) || { start: time, count: 0 };
    if (time - windowStart >= 60_000) { windowStart = time; requests = 0; }
    if (client.count >= 6 || requests >= 30 || active >= 2 || (!clients.has(ip) && clients.size >= 1_000)) {
      response.setHeader("Retry-After", "60");
      return sendJson(response, 429, { error: "Слишком много запросов. Попробуйте через минуту." });
    }
    client.count += 1;
    clients.set(ip, client);
    requests += 1;
    active += 1;
    const controller = new AbortController();
    const onCancel = () => controller.abort();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    // Vercel's Node req/res API reports cancellation via request error;
    // also accept request.signal when supplied by the runtime.
    request.on("error", onCancel);
    request.signal?.addEventListener("abort", onCancel, { once: true });
    if (request.signal?.aborted) onCancel();
    response.on("close", onClose);
    try {
      const body = await readJsonBody(request);
      const messages = sanitizeMessages(body?.messages);
      if (!messages) throw new HttpError(400);
      controller.signal.throwIfAborted();
      startEventStream(response);
      const reply = await requestOpenAI(messages, fetchImplementation, controller.signal, {
        onRetry: () => {
          if (!response.destroyed) sendEvent(response, { type: "status", status: "retrying" });
        },
      });
      if (!response.destroyed) {
        sendEvent(response, { type: "reply", reply });
        response.end();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.destroyed) response.end();
        return;
      }
      // Never log arbitrary errors, causes, headers, prompts or provider bodies.
      console.error("[chat] request_failed");
      if (response.destroyed) return;
      if (response.headersSent) {
        sendEvent(response, { type: "error", error: API_ERROR_MESSAGE });
        response.end();
      } else {
        const status = error instanceof HttpError ? error.status : 503;
        sendJson(response, status, { error: status === 400 ? "Некорректное сообщение." : API_ERROR_MESSAGE });
      }
    } finally {
      active -= 1;
      request.off("error", onCancel);
      request.signal?.removeEventListener("abort", onCancel);
      response.off("close", onClose);
    }
  };
}

const handleChat = createChatHandler();

async function serveStatic(pathname, response) {
  const staticFile = STATIC_FILES.get(pathname);
  if (!staticFile) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const [fileName, contentType] = staticFile;
    const content = await fs.readFile(path.join(PUBLIC_DIR, fileName));
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(content);
  } catch (error) {
    console.error("[static] read_failed");
    sendJson(response, 500, { error: "Internal server error" });
  }
}

function createServer(chatHandler = handleChat) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);

    if (url.pathname === "/api/chat") {
      await chatHandler(request, response);
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  });
}

if (require.main === module) {
  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_PORT;
  const server = createServer();

  server.listen(port, HOST, () => {
    console.log(`ServicePilot Support Lite is running at http://${HOST}:${port}`);
  });

  function shutDown() {
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
}

module.exports = {
  API_ERROR_MESSAGE,
  SYSTEM_PROMPT,
  createServer,
  createChatHandler,
  handleChat,
  extractResponseText,
  requestOpenAI,
  sanitizeMessages,
};
