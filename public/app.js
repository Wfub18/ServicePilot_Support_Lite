const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const messagesElement = document.querySelector("#messages");

const ERROR_MESSAGE = "Сейчас не удалось получить ответ. Пожалуйста, попробуйте ещё раз.";
const WAITING_MESSAGE = "Получаю ответ…";
const RETRYING_MESSAGE = "Связь нестабильна, повторяю запрос…";
const conversation = [];
let isSending = false;

function scrollToLatest() {
  messagesElement.scrollTo({
    top: messagesElement.scrollHeight,
    behavior: "smooth",
  });
}

function createMessage(role, text, options = {}) {
  const article = document.createElement("article");
  const isUser = role === "user";
  article.className = `message ${isUser ? "user-message" : "assistant-message"}`;

  if (options.error) {
    article.classList.add("error-message");
  }

  if (!isUser) {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "SP";
    article.append(avatar);
  }

  const content = document.createElement("div");
  content.className = "message-content";

  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = isUser ? "Вы" : "AI-администратор";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = isUser ? text : text.replaceAll("**", "");

  content.append(author, bubble);
  article.append(content);
  messagesElement.append(article);
  scrollToLatest();

  return article;
}

function createStatusMessage(text) {
  const status = document.createElement("div");
  status.className = "status-message";
  status.setAttribute("role", "status");

  const bubble = document.createElement("div");
  bubble.className = "status-bubble";

  const dots = document.createElement("span");
  dots.className = "status-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    dots.append(document.createElement("span"));
  }

  const label = document.createElement("span");
  label.className = "status-text";
  label.textContent = text;

  bubble.append(dots, label);
  status.append(bubble);
  messagesElement.append(status);
  scrollToLatest();

  return { status, label };
}

async function readChatEvents(response, onEvent) {
  if (!response.body) {
    throw new Error("Streaming response is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }

    if (done) break;
  }

  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function setSending(value) {
  isSending = value;
  input.disabled = value;
  sendButton.disabled = value;
  sendButton.setAttribute("aria-busy", String(value));
}

async function sendMessage(text) {
  conversation.push({ role: "user", content: text });
  createMessage("user", text);
  const { status: statusMessage, label: statusText } = createStatusMessage(WAITING_MESSAGE);
  setSending(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation.slice(-24) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Chat request failed");
    }

    let reply = "";
    let requestError = "";
    await readChatEvents(response, (event) => {
      if (event.type === "status" && event.status === "retrying") {
        statusText.textContent = RETRYING_MESSAGE;
        scrollToLatest();
      } else if (event.type === "reply" && typeof event.reply === "string") {
        reply = event.reply.trim();
      } else if (event.type === "error") {
        requestError = event.error || ERROR_MESSAGE;
      }
    });

    if (requestError || !reply) {
      throw new Error(requestError || "Empty API response");
    }

    statusMessage.remove();
    conversation.push({ role: "assistant", content: reply });
    createMessage("assistant", reply);
  } catch (error) {
    console.error("Chat request failed:", error);
    statusMessage.remove();
    createMessage("assistant", ERROR_MESSAGE, { error: true });
  } finally {
    setSending(false);
    input.focus();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isSending) return;

  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  resizeInput();
  await sendMessage(text);
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.focus();
