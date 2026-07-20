import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// --- Файл, куда сохраняется список заявок на запись (переживает перезапуск) ---
const BOOKINGS_FILE = "./bookings.json";
const CLIENTS_FILE = "./clients.json";
const BOOKINGS_SECRET = process.env.BOOKINGS_SECRET || "moika123";
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // например https://avtomoika-bot-production.up.railway.app

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

function markClientBooking(chatId) {
  const clients = loadClients();
  if (clients[chatId]) {
    clients[chatId].bookingsCount += 1;
    saveClients(clients);
  }
}

const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "openai/gpt-oss-120b";

const GREEN_API_ID = process.env.GREEN_API_ID_INSTANCE;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN_INSTANCE;
const GREEN_API_BASE = `https://api.green-api.com/waInstance${GREEN_API_ID}`;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || "Ты — вежливый ассистент компании. Отвечай кратко.";

const BOOKING_KEYWORDS = (process.env.BOOKING_KEYWORDS || "запись,записать,записаться")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

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

async function notifyTelegram(bookingId, clientChatId, senderName, messageText) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text =
    `📥 Новая заявка на запись (№${bookingId})\n\n` +
    `Клиент: ${senderName || "не указан"}\n` +
    `WhatsApp: ${clientChatId}\n` +
    `Сообщение: ${messageText}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: `confirm:${bookingId}` },
        { text: "🔁 Перенести", callback_data: `reschedule:${bookingId}` },
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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.typeWebhook !== "incomingMessageReceived") return;

    const chatId = body.senderData?.chatId;
    const senderName = body.senderData?.senderName;
    const messageType = body.messageData?.typeMessage;

    if (messageType !== "textMessage" && messageType !== "extendedTextMessage") {
      await sendWhatsAppMessage(chatId, "Пока умею отвечать только на текстовые сообщения 🙂");
      return;
    }

    const userText =
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text;

    if (!chatId || !userText) return;

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
      markClientBooking(chatId);
      await notifyTelegram(bookingId, chatId, senderName, userText);
    }

    const reply = await generateReply(chatId, userText);
    await sendWhatsAppMessage(chatId, reply);
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
        <p><a href="/clients?key=${BOOKINGS_SECRET}">→ Открыть список клиентов</a></p>
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
        <td>${c.name}</td>
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
        <p><a href="/bookings?key=${BOOKINGS_SECRET}">→ Открыть список заявок</a></p>
        <h2>Клиенты (${clients.length})</h2>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  setupTelegramWebhook();
});
