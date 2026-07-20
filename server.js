import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// --- Файлы данных (переживают перезапуск) ---
const BOOKINGS_FILE = "./bookings.json";
const CLIENTS_FILE = "./clients.json";
const STATE_FILE = "./state.json"; // для утренней сводки (какой день уже отправляли)
const BOOKINGS_SECRET = process.env.BOOKINGS_SECRET || "moika123";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

function loadBookings() {
  try {
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveBookingsList(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2), "utf-8");
}

function saveBooking(entry) {
  const bookings = loadBookings();
  bookings.unshift(entry);
  saveBookingsList(bookings);
}

function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveClients(clients) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), "utf-8");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function recordClientMessage(chatId, senderName, text) {
  const clients = loadClients();
  const now = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" });
  if (!clients[chatId]) {
    clients[chatId] = {
      chatId,
      name: senderName || "не указан",
      firstSeen: now,
      lastSeen: now,
      messagesCount: 0,
      bookingsCount: 0,
      history: [],
    };
  }
  const client = clients[chatId];
  if (senderName) client.name = senderName;
  client.lastSeen = now;
  client.messagesCount += 1;
  client.history.push({ date: now, text });
  if (client.history.length > 50) client.history.splice(0, client.history.length - 50);
  saveClients(clients);
  return client;
}

// Возвращает true, если это уже 4-й (или больше) визит — постоянный клиент
function markClientBooking(chatId) {
  const clients = loadClients();
  let isLoyal = false;
  if (clients[chatId]) {
    clients[chatId].bookingsCount += 1;
    isLoyal = clients[chatId].bookingsCount >= 4;
    saveClients(clients);
  }
  return isLoyal;
}

const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_WHISPER_MODEL = "whisper-large-v3";

const GREEN_API_ID = process.env.GREEN_API_ID_INSTANCE;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN_INSTANCE;
const GREEN_API_BASE = `https://api.green-api.com/waInstance${GREEN_API_ID}`;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SYSTEM_PROMPT_BASE =
  process.env.SYSTEM_PROMPT || "Ты — вежливый ассистент компании. Отвечай кратко.";

const BOOKING_INSTRUCTIONS = `

При обращении клиента с просьбой записаться ОБЯЗАТЕЛЬНО уточняй по порядку, если этого нет в сообщении:
1) какая услуга нужна (мойка, тонировка, химчистка, полировка и т.д.)
2) желаемая дата и время
3) номер машины (гос. номер)
Пока не получишь все три пункта — не считай запись оформленной, задавай уточняющие вопросы по одному.
Как только получишь все данные, подведи итог клиенту в формате:
"Записал(а) вас: услуга — ..., время — ..., машина — ...".`;

const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE + BOOKING_INSTRUCTIONS;

const BOOKING_KEYWORDS = (process.env.BOOKING_KEYWORDS || "запись,записать,записаться")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

// Через сколько часов после отметки "Готово" спрашивать отзыв у клиента
const FEEDBACK_DELAY_HOURS = Number(process.env.FEEDBACK_DELAY_HOURS || 1);

const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20;

function getHistory(chatId) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

const awaitingReschedule = new Map();
const pendingBookings = new Map(); // chatId -> bookingId

function looksLikeBookingRequest(text) {
  const lower = text.toLowerCase();
  return BOOKING_KEYWORDS.some((kw) => lower.includes(kw));
}

async function sendWhatsAppMessage(chatId, message) {
  const url = `${GREEN_API_BASE}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message });
}

async function sendTelegramMessage(tgChatId, text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: tgChatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await axios.post(url, payload);
}

async function answerCallbackQuery(callbackQueryId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await axios.post(url, { callback_query_id: callbackQueryId, text });
}

async function setupTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (!PUBLIC_URL) {
    console.log("PUBLIC_URL не задан — вебхук Telegram (кнопки) не будет настроен автоматически.");
    return;
  }
  try {
    const webhookUrl = `${PUBLIC_URL}/telegram-webhook`;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      url: webhookUrl,
    });
    console.log("Telegram webhook установлен:", webhookUrl);
  } catch (err) {
    console.error("Не удалось установить Telegram webhook:", err?.response?.data || err.message);
  }
}

async function notifyTelegram(bookingId, clientChatId, senderName, messageText, isLoyal) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text =
    `📥 Новая заявка на запись (№${bookingId})\n\n` +
    `Клиент: ${senderName || "не указан"}${isLoyal ? " 🎁 (постоянный клиент)" : ""}\n` +
    `WhatsApp: ${clientChatId}\n` +
    `Сообщение: ${messageText}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: `confirm:${bookingId}` },
        { text: "🔁 Перенести", callback_data: `reschedule:${bookingId}` },
      ],
      [
        { text: "🏁 Готово", callback_data: `done:${bookingId}` },
        { text: "❌ Отклонить", callback_data: `reject:${bookingId}` },
      ],
    ],
  };

  await sendTelegramMessage(TELEGRAM_CHAT_ID, text, replyMarkup);
}

async function generateReply(chatId, userMessage) {
  pushToHistory(chatId, "user", userMessage);

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      max_tokens: 500,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...getHistory(chatId)],
    },
    { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
  );

  const replyText = response.data.choices[0].message.content;
  pushToHistory(chatId, "assistant", replyText);
  return replyText;
}

// --- Распознавание голосовых сообщений через Groq Whisper ---
async function transcribeVoice(fileUrl) {
  const audioResponse = await axios.get(fileUrl, { responseType: "arraybuffer" });

  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", Buffer.from(audioResponse.data), "voice.ogg");
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("language", "ru");

  const response = await axios.post(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    form,
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        ...form.getHeaders(),
      },
    }
  );

  return response.data.text;
}

// --- Обработка одного текста от клиента (общая для текста и распознанного голоса) ---
async function handleClientText(chatId, senderName, userText) {
  recordClientMessage(chatId, senderName, userText);

  if (looksLikeBookingRequest(userText)) {
    const bookingId = Date.now();
    saveBooking({
      id: bookingId,
      date: new Date().toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" }),
      chatId,
      senderName: senderName || "не указан",
      message: userText,
      status: "новая",
    });
    const isLoyal = markClientBooking(chatId);
    pendingBookings.set(chatId, bookingId);
    await notifyTelegram(bookingId, chatId, senderName, userText, isLoyal);
  } else if (pendingBookings.has(chatId)) {
    const bookingId = pendingBookings.get(chatId);
    const bookings = loadBookings();
    const booking = bookings.find((b) => String(b.id) === String(bookingId));
    if (booking) {
      booking.message = `${booking.message}\n+ ${userText}`;
      saveBookingsList(bookings);
      await sendTelegramMessage(
        TELEGRAM_CHAT_ID,
        `🔎 Уточнение по заявке №${bookingId} от ${senderName || booking.senderName}:\n${userText}`
      );
    }
  } else {
    // Проверка: это цифра 1-5 в ответ на запрос отзыва?
    const trimmed = userText.trim();
    if (/^[1-5]$/.test(trimmed)) {
      await sendTelegramMessage(
        TELEGRAM_CHAT_ID,
        `⭐ Клиент ${senderName || chatId} поставил оценку: ${trimmed}/5`
      );
    }
  }

  const reply = await generateReply(chatId, userText);
  await sendWhatsAppMessage(chatId, reply);
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.typeWebhook !== "incomingMessageReceived") return;

    const chatId = body.senderData?.chatId;
    const senderName = body.senderData?.senderName;
    const messageType = body.messageData?.typeMessage;

    if (!chatId) return;

    if (messageType === "textMessage" || messageType === "extendedTextMessage") {
      const userText =
        body.messageData?.textMessageData?.textMessage ||
        body.messageData?.extendedTextMessageData?.text;
      if (!userText) return;
      await handleClientText(chatId, senderName, userText);
      return;
    }

    if (messageType === "audioMessage" || messageType === "voiceMessage" || messageType === "ptt") {
      const fileUrl = body.messageData?.fileMessageData?.downloadUrl;
      if (!fileUrl) {
        await sendWhatsAppMessage(chatId, "Не смог обработать голосовое сообщение, попробуйте написать текстом 🙂");
        return;
      }
      try {
        const transcribed = await transcribeVoice(fileUrl);
        await handleClientText(chatId, senderName, transcribed);
      } catch (err) {
        console.error("Ошибка распознавания голоса:", err?.response?.data || err.message);
        await sendWhatsAppMessage(chatId, "Не удалось распознать голосовое сообщение, напишите, пожалуйста, текстом 🙂");
      }
      return;
    }

    await sendWhatsAppMessage(chatId, "Пока умею отвечать только на текстовые и голосовые сообщения 🙂");
  } catch (err) {
    console.error("Ошибка обработки сообщения:", err?.response?.data || err.message);
  }
});

app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.callback_query) {
      const cq = update.callback_query;
      const tgChatId = cq.message?.chat?.id;
      const [action, idStr] = (cq.data || "").split(":");
      const bookings = loadBookings();
      const booking = bookings.find((b) => String(b.id) === idStr);

      if (!booking) {
        await answerCallbackQuery(cq.id, "Заявка не найдена");
        return;
      }

      if (action === "confirm") {
        booking.status = "подтверждена ✅";
        saveBookingsList(bookings);
        await sendWhatsAppMessage(
          booking.chatId,
          "Здравствуйте! Ваша запись подтверждена ✅ Ждём вас в указанное время."
        );
        pendingBookings.delete(booking.chatId);
        await answerCallbackQuery(cq.id, "Подтверждено");
        await sendTelegramMessage(
          tgChatId,
          `✅ Заявка №${booking.id} (${booking.senderName}) подтверждена, клиенту отправлено уведомление.`
        );
      } else if (action === "reschedule") {
        awaitingReschedule.set(tgChatId, { bookingId: booking.id });
        await answerCallbackQuery(cq.id, "Напишите новое время в чат");
        await sendTelegramMessage(
          tgChatId,
          `🔁 Напишите обычным сообщением новое время для клиента ${booking.senderName} (заявка №${booking.id}). Я перешлю его клиенту.`
        );
      } else if (action === "reject") {
        booking.status = "отклонена, ждём предложение клиента";
        saveBookingsList(bookings);
        pendingBookings.set(booking.chatId, booking.id);
        await sendWhatsAppMessage(
          booking.chatId,
          "Здравствуйте! К сожалению, это время недоступно. Пожалуйста, предложите другое удобное для вас время."
        );
        await answerCallbackQuery(cq.id, "Отклонено");
        await sendTelegramMessage(
          tgChatId,
          `❌ Заявка №${booking.id} (${booking.senderName}) отклонена. Клиенту предложено назвать другое время — сообщу, когда ответит.`
        );
      } else if (action === "done") {
        booking.status = "выполнена 🏁";
        booking.completedAt = Date.now();
        booking.feedbackSent = false;
        saveBookingsList(bookings);
        pendingBookings.delete(booking.chatId);
        await answerCallbackQuery(cq.id, "Отмечено как готово");
        await sendTelegramMessage(
          tgChatId,
          `🏁 Заявка №${booking.id} (${booking.senderName}) отмечена как выполненная. Через ${FEEDBACK_DELAY_HOURS} ч. спрошу у клиента отзыв (ответом 1-5).`
        );
      }
      return;
    }

    if (update.message && update.message.text) {
      const tgChatId = update.message.chat.id;
      const pending = awaitingReschedule.get(tgChatId);

      if (pending) {
        const bookings = loadBookings();
        const booking = bookings.find((b) => String(b.id) === String(pending.bookingId));

        if (booking) {
          const newTime = update.message.text;
          booking.status = `предложен перенос на: ${newTime}`;
          saveBookingsList(bookings);
          await sendWhatsAppMessage(
            booking.chatId,
            `Здравствуйте! Предлагаем перенести вашу запись на: ${newTime}. Подходит вам такое время?`
          );
          await sendTelegramMessage(
            tgChatId,
            `✅ Клиенту ${booking.senderName} отправлено предложение нового времени: ${newTime}`
          );
        }
        awaitingReschedule.delete(tgChatId);
      }
    }
  } catch (err) {
    console.error("Ошибка обработки Telegram webhook:", err?.response?.data || err.message);
  }
});

app.get("/", (req, res) => res.send("WhatsApp AI bot работает."));

// --- Раз в 15 минут проверяем: не пора ли спросить отзыв у клиента ---
async function checkAndSendFeedback() {
  try {
    const bookings = loadBookings();
    const delayMs = FEEDBACK_DELAY_HOURS * 60 * 60 * 1000;
    let changed = false;

    for (const b of bookings) {
      if (b.completedAt && !b.feedbackSent && Date.now() - b.completedAt >= delayMs) {
        await sendWhatsAppMessage(
          b.chatId,
          "Здравствуйте! Спасибо, что выбрали нас 🙂 Оцените, пожалуйста, обслуживание одним числом от 1 до 5 (5 — отлично)."
        );
        b.feedbackSent = true;
        changed = true;
      }
    }

    if (changed) saveBookingsList(bookings);
  } catch (err) {
    console.error("Ошибка при отправке запроса на отзыв:", err?.response?.data || err.message);
  }
}

// --- Раз в 15 минут проверяем: не пора ли отправить утреннюю сводку (в 8:00) ---
async function checkMorningSummary() {
  try {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bishkek" }));
    const today = now.toISOString().slice(0, 10);
    const state = loadState();

    if (now.getHours() !== 8 || state.lastSummaryDate === today) return;

    const bookings = loadBookings();
    const active = bookings.filter(
      (b) => !b.status.startsWith("выполнена") && !b.status.startsWith("отклонена")
    );

    const text =
      `🌅 Доброе утро! Сводка на сегодня\n\n` +
      `Активных заявок: ${active.length}\n\n` +
      (active
        .slice(0, 15)
        .map((b) => `• ${b.senderName} — ${b.message.split("\n")[0]} (статус: ${b.status})`)
        .join("\n") || "Заявок нет");

    await sendTelegramMessage(TELEGRAM_CHAT_ID, text);
    state.lastSummaryDate = today;
    saveState(state);
  } catch (err) {
    console.error("Ошибка при отправке утренней сводки:", err?.response?.data || err.message);
  }
}

app.get("/bookings", (req, res) => {
  if (req.query.key !== BOOKINGS_SECRET) {
    return res.status(403).send("Доступ запрещён. Добавьте правильный ?key=... в адрес.");
  }

  const bookings = loadBookings();
  const rows = bookings
    .map(
      (b, i) => `
      <tr>
        <td>${bookings.length - i}</td>
        <td>${b.date}</td>
        <td>${b.senderName}</td>
        <td>${b.chatId}</td>
        <td>${b.message}</td>
        <td>${b.status}</td>
      </tr>`
    )
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Заявки на запись</title>
        <style>
          body { font-family: sans-serif; margin: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; font-size: 14px; }
          th { background: #f0f0f0; }
          tr:nth-child(even) { background: #fafafa; }
          a { color: #2563eb; }
        </style>
      </head>
      <body>
        <p><a href="/clients?key=${BOOKINGS_SECRET}">→ Открыть список клиентов</a> &nbsp;|&nbsp; <a href="/export?key=${BOOKINGS_SECRET}">→ Скачать CSV</a></p>
        <h2>Заявки на запись (${bookings.length})</h2>
        <table>
          <tr><th>№</th><th>Дата</th><th>Имя</th><th>WhatsApp</th><th>Сообщение</th><th>Статус</th></tr>
          ${rows || "<tr><td colspan='6'>Пока нет заявок</td></tr>"}
        </table>
      </body>
    </html>
  `);
});

app.get("/clients", (req, res) => {
  if (req.query.key !== BOOKINGS_SECRET) {
    return res.status(403).send("Доступ запрещён. Добавьте правильный ?key=... в адрес.");
  }

  const clients = Object.values(loadClients()).sort((a, b) =>
    a.lastSeen < b.lastSeen ? 1 : -1
  );

  const rows = clients
    .map(
      (c) => `
      <tr>
        <td>${c.name}${c.bookingsCount >= 4 ? " 🎁" : ""}</td>
        <td>${c.chatId}</td>
        <td>${c.firstSeen}</td>
        <td>${c.lastSeen}</td>
        <td>${c.messagesCount}</td>
        <td>${c.bookingsCount}</td>
        <td>${(c.history || [])
          .slice(-3)
          .map((h) => `${h.date}: ${h.text}`)
          .join("<br>")}</td>
      </tr>`
    )
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Клиенты</title>
        <style>
          body { font-family: sans-serif; margin: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
          th { background: #f0f0f0; }
          tr:nth-child(even) { background: #fafafa; }
          a { color: #2563eb; }
        </style>
      </head>
      <body>
        <p><a href="/bookings?key=${BOOKINGS_SECRET}">→ Открыть список заявок</a> &nbsp;|&nbsp; <a href="/export?key=${BOOKINGS_SECRET}">→ Скачать CSV</a></p>
        <h2>Клиенты (${clients.length}) &nbsp; 🎁 = постоянный клиент (4+ заявок)</h2>
        <table>
          <tr>
            <th>Имя</th><th>WhatsApp</th><th>Первое обращение</th><th>Последнее обращение</th>
            <th>Сообщений всего</th><th>Заявок на запись</th><th>Последние сообщения</th>
          </tr>
          ${rows || "<tr><td colspan='7'>Пока нет клиентов</td></tr>"}
        </table>
      </body>
    </html>
  `);
});

// --- Выгрузка заявок в CSV (открывается в Excel) ---
app.get("/export", (req, res) => {
  if (req.query.key !== BOOKINGS_SECRET) {
    return res.status(403).send("Доступ запрещён. Добавьте правильный ?key=... в адрес.");
  }

  const bookings = loadBookings();
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["№", "Дата", "Имя", "WhatsApp", "Сообщение", "Статус"].join(";");
  const rows = bookings
    .map((b, i) =>
      [bookings.length - i, b.date, b.senderName, b.chatId, b.message, b.status]
        .map(escape)
        .join(";")
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=zayavki.csv");
  res.send("\uFEFF" + header + "\n" + rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  setupTelegramWebhook();
  setInterval(checkAndSendFeedback, 15 * 60 * 1000);
  setInterval(checkMorningSummary, 15 * 60 * 1000);
});
