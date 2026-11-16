import { Bot, Context } from "grammy";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("stats.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS status (
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, thread_id)
);
CREATE TABLE IF NOT EXISTS counts (
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  chars_with_spaces INTEGER NOT NULL DEFAULT 0,
  chars_without_spaces INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, thread_id, user_id, date)
);
CREATE TABLE IF NOT EXISTS ephemeral (
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_id, user_id)
);
`);

const qStatus = db.prepare(
  "SELECT enabled FROM status WHERE chat_id = ? AND thread_id = ?",
);
const qUpsertStatus = db.prepare(
  "INSERT INTO status (chat_id, thread_id, enabled) VALUES (?, ?, ?) " +
    "ON CONFLICT (chat_id, thread_id) DO UPDATE SET enabled = excluded.enabled",
);
const qIncrement = db.prepare(`
  INSERT INTO counts (chat_id, thread_id, user_id, date, messages, words, chars_with_spaces, chars_without_spaces)
  VALUES (@chatId, @threadId, @userId, @date, 1, @words, @withSpaces, @withoutSpaces)
  ON CONFLICT (chat_id, thread_id, user_id, date) DO UPDATE SET
    messages = messages + 1,
    words = words + excluded.words,
    chars_with_spaces = chars_with_spaces + excluded.chars_with_spaces,
    chars_without_spaces = chars_without_spaces + excluded.chars_without_spaces
`);
const qToday = db.prepare(
  "SELECT messages, words, chars_with_spaces, chars_without_spaces FROM counts " +
    "WHERE chat_id = ? AND thread_id = ? AND user_id = ? AND date = ?",
);

const qGetEphemeral = db.prepare(
  "SELECT message_id FROM ephemeral WHERE chat_id = ? AND thread_id = ? AND user_id = ?",
);
const qPutEphemeral = db.prepare(
  "INSERT INTO ephemeral (chat_id, thread_id, user_id, message_id) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (chat_id, thread_id, user_id) DO UPDATE SET message_id = excluded.message_id",
);
const qDeleteEphemeral = db.prepare(
  "DELETE FROM ephemeral WHERE chat_id = ? AND thread_id = ? AND user_id = ?",
);

const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
const threadKey = (threadId?: number) => threadId ?? 0;

function removeEphemeral(chatId: number, threadId: number, userId: number) {
  const row = qGetEphemeral.get(chatId, threadId, userId);
  if (!row) return;
  qDeleteEphemeral.run(chatId, threadId, userId);
  return bot.api
    .deleteEphemeralMessage(chatId, userId, row.message_id as number)
    .catch(() => {});
}

function sendEphemeral(ctx: Context, text: string) {
  if (ctx.chat!.type === "private") return ctx.reply(text);
  const chatId = ctx.chat!.id;
  const threadId = threadKey(ctx.msg!.message_thread_id);
  const userId = ctx.from!.id;
  const message_id = ctx.msg!.message_id;
  const ephemeral_message_id = ctx.msg!.ephemeral_message_id;
  const prev = removeEphemeral(chatId, threadId, userId);
  const send = () =>
    ctx
      .reply(text, {
        reply_parameters: { message_id, ephemeral_message_id },
        ephemeral_message_parameters: { receiver_user_id: userId },
      })
      .then((sent) => {
        console.log(sent);
        qPutEphemeral.run(chatId, threadId, userId, sent.ephemeral_message_id!);
      });
  return prev ? prev.then(send, send) : send();
}

const bot = new Bot(process.env.BOT_TOKEN!);

bot.api.setMyCommands([{ command: "start", description: "Начать" }], {
  scope: { type: "all_private_chats" },
});
bot.api.setMyCommands(
  [
    { command: "start", description: "Начать", is_ephemeral: true },
    {
      command: "toggle_count",
      description: "Включить/выключить подсчёт слов",
      is_ephemeral: true,
    },
  ],
  { scope: { type: "all_group_chats" } },
);

bot.command("start", (ctx) =>
  sendEphemeral(
    ctx,
    "Привет! Я считаю сообщения и слова. Используй /toggle_count, чтобы включить или выключить подсчёт.",
  ),
);

bot.command("toggle_count", (ctx) => {
  if (ctx.chat!.type === "private") {
    return sendEphemeral(
      ctx,
      "Подсчёт слов всегда включен в личных сообщениях!",
    );
  }
  if (ctx.chat!.type === "channel") {
    return sendEphemeral(ctx, "Подсчёт слов нельзя включить в канале!");
  }
  const chatId = ctx.chat!.id;
  const threadId = threadKey(ctx.msg!.message_thread_id);
  const current = qStatus.get(chatId, threadId);
  const enabled = current ? Number(!current.enabled) : 1;
  console.log(chatId, threadId, enabled);
  qUpsertStatus.run(chatId, threadId, enabled);
  return sendEphemeral(
    ctx,
    `Подсчёт слов ${enabled ? "включен" : "выключен"} в этом чате!`,
  );
});

bot.on("msg:text", (ctx) => {
  const chatType = ctx.chat!.type;
  if (chatType === "channel") return;
  const chatId = ctx.chat!.id;
  const threadId = threadKey(ctx.msg!.message_thread_id);

  let enabled = chatType === "private";
  if (!enabled) {
    const row = qStatus.get(chatId, threadId);
    if (!row || !row.enabled) return;
  }

  const text = ctx.msg!.text!;
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  const date = today();
  qIncrement.run({
    chatId,
    threadId,
    userId: ctx.from!.id,
    date,
    words,
    withSpaces: text.length,
    withoutSpaces: text.replace(/\s/g, "").length,
  });

  const row = qToday.get(chatId, threadId, ctx.from!.id, date)!;
  return sendEphemeral(
    ctx,
    `За сегодня вы написали ${row.messages} сообщений / ${row.words} слов / ` +
      `${row.chars_with_spaces} зн. с проб. / ${row.chars_without_spaces} зн. без пробелов`,
  );
});

bot.catch((err) => console.error(err));
bot.start();
