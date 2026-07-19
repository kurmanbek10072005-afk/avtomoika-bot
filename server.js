import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// --- Файл, куда сохраняется список заявок на запись (переживает перезапуск) ---
const BOOKINGS_FILE = "./bookings.json";
const BOOKINGS_SECRET = process.env.BOOKINGS_SECRET || "moika123";

function loadBookings() {
  try {
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveBooking(entry) {
  const bookings = loadBookings();
  bookings.unshift(entry); // новые сверху
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2), "utf-8");
}

const app = express();
app.use(express.json());

// --- Настройки из .env ---
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

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

// --- Память диалогов (в оперативной памяти процесса, сбрасывается при перезапуске) ---
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

// --- Проверка, похоже ли сообщение на просьбу о записи ---
function looksLikeBookingRequest(text) {
  const lower = text.toLowerCase();
  return BOOKING_KEYWORDS.some((kw) => lower.includes(kw));
}

// --- Отправка ответа клиенту в WhatsApp через GREEN-API ---
async function sendWhatsAppMessage(chatId, message) {
  const url = `${GREEN_API_BASE}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message });
}

// --- Уведомление менеджеру в Телеграм о новой заявке ---
async function notifyTelegram(clientChatId, senderName, messageText) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text =
    `📥 Новая заявка на запись\n\n` +
    `Клиент: ${senderName || "не указан"}\n` +
    `WhatsApp: ${clientChatId}\n` +
    `Сообщение: ${messageText}`;
  await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text });
}

// --- Генерация ответа через Groq (модель Llama) ---
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

// --- Вебхук от GREEN-API на входящие сообщения WhatsApp ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // отвечаем сразу, обработку делаем асинхронно

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

    // Если это похоже на просьбу о записи — уведомляем менеджера в Телеграм и сохраняем в список
    if (looksLikeBookingRequest(userText)) {
      await notifyTelegram(chatId, senderName, userText);
      saveBooking({
        date: new Date().toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" }),
        chatId,
        senderName: senderName || "не указан",
        message: userText,
        status: "новая",
      });
    }

    // В любом случае бот отвечает клиенту сам
    const reply = await generateReply(chatId, userText);
    await sendWhatsAppMessage(chatId, reply);
  } catch (err) {
    console.error("Ошибка обработки сообщения:", err?.response?.data || err.message);
  }
});

app.get("/", (req, res) => res.send("WhatsApp AI bot работает."));

// --- Страница со списком заявок на запись (открывается в браузере) ---
// Адрес: <ваш-адрес>/bookings?key=ВАШ_СЕКРЕТНЫЙ_КЛЮЧ
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
        </style>
      </head>
      <body>
        <h2>Заявки на запись (${bookings.length})</h2>
        <table>
          <tr><th>№</th><th>Дата</th><th>Имя</th><th>WhatsApp</th><th>Сообщение</th><th>Статус</th></tr>
          ${rows || "<tr><td colspan='6'>Пока нет заявок</td></tr>"}
        </table>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
