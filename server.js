const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_API_ATTEMPTS = 7;
const RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 12_000];
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

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_SIZE) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
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

  if (messages.some((message) => message === null)) {
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

function isRetryableNetworkError(error) {
  const code = error?.code ?? error?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    (error?.name === "TypeError" && /fetch failed/i.test(error.message || ""))
  );
}

async function requestOpenAI(messages, fetchImplementation = fetch, onRetry = () => {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_api_key_here") {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) throw controller.signal.reason;

      let apiResponse;
      let data;
      try {
        apiResponse = await fetchImplementation("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
            instructions: SYSTEM_PROMPT,
            input: messages,
            store: false,
          }),
          signal: controller.signal,
        });

        if (apiResponse.ok) {
          data = await apiResponse.json().catch((error) => {
            if (isRetryableNetworkError(error)) throw error;
            return null;
          });
        }
      } catch (error) {
        const safe = (value) =>
          typeof value === "string" ? value.replaceAll(apiKey, "[REDACTED]") : value;
        const cause = error?.cause;
        const causeDetails = cause == null
          ? null
          : typeof cause === "object"
            ? {
                name: safe(cause.name),
                message: safe(cause.message),
                code: safe(cause.code),
                errno: safe(cause.errno),
                syscall: safe(cause.syscall),
                hostname: safe(cause.hostname),
              }
            : safe(cause);

        console.error("[openai network]", JSON.stringify({
          attempt,
          "error.name": safe(error?.name),
          "error.message": safe(error?.message),
          "error.cause": causeDetails,
          code: safe(error?.code ?? cause?.code),
          errno: safe(error?.errno ?? cause?.errno),
          syscall: safe(error?.syscall ?? cause?.syscall),
          hostname: safe(error?.hostname ?? cause?.hostname),
        }));

        if (attempt < MAX_API_ATTEMPTS && isRetryableNetworkError(error) && !controller.signal.aborted) {
          onRetry();
          await delay(RETRY_DELAYS_MS[attempt - 1], undefined, { signal: controller.signal });
          continue;
        }
        throw error;
      }

      if (!apiResponse.ok) {
        data = await apiResponse.json().catch(() => null);
        const apiMessage = data?.error?.message || `OpenAI API error ${apiResponse.status}`;
        throw new Error(apiMessage);
      }

      const text = extractResponseText(data);
      if (!text) {
        throw new Error("OpenAI API returned an empty response");
      }

      console.info("[openai] success", JSON.stringify({ attempt }));
      return text;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleChat(request, response) {
  try {
    const body = await readJsonBody(request);
    const messages = sanitizeMessages(body.messages);

    if (!messages) {
      sendJson(response, 400, { error: "Некорректное сообщение." });
      return;
    }

    startEventStream(response);
    const reply = await requestOpenAI(messages, fetch, () => {
      sendEvent(response, { type: "status", status: "retrying" });
    });
    sendEvent(response, { type: "reply", reply });
    response.end();
  } catch (error) {
    const reason = error?.name === "AbortError" ? "API timeout" : error?.message;
    console.error(`[chat] ${reason || "Unknown API error"}`);
    if (response.headersSent) {
      sendEvent(response, { type: "error", error: API_ERROR_MESSAGE });
      response.end();
    } else {
      sendJson(response, 503, { error: API_ERROR_MESSAGE });
    }
  }
}

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
    console.error(`[static] ${error.message}`);
    sendJson(response, 500, { error: "Internal server error" });
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || HOST}`);

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
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
  extractResponseText,
  requestOpenAI,
  sanitizeMessages,
};
