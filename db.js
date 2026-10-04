// db.js — ma'lumotlar bazasi (JSON fayl), XOTIRADA ishlaydi.
// - Baza bir marta o'qiladi va xotirada turadi (tez).
// - O'zgarishlar faylga 2 soniyada bir marta, XAVFSIZ yoziladi (avval vaqtinchalik faylga,
//   keyin almashtiriladi — yozish paytida tok o'chsa ham asosiy fayl buzilmaydi).
// - Har kuni avtomatik zaxira nusxa (backups/ papkasida, oxirgi 7 kun).
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, "data.json");
const TMP_FILE = DB_FILE + ".tmp";
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 7;
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function defaultData() {
  return {
    admins: [], // birinchi ishga tushishda admin yaratiladi
    drivers: [
      {
        id: 1,
        name: "Aziz Karimov",
        phone: "+998901234567",
        password: "1234", // birinchi yuklanishda shifrlanadi
        carClass: "komfort",
        carModel: "Cobalt",
        carNumber: "",
        status: "offline",
        lat: null,
        lng: null,
        credit: 0,
        zoneId: null,
        queuedAt: null,
        outsideSince: null,
        blocked: false,
        updatedAt: new Date().toISOString(),
      },
    ],
    zones: [],
    places: [],
    orders: [],
    messages: [],
    settings: {},
    nextOrderId: 1,
    nextDriverId: 2,
    nextZoneId: 1,
    nextMessageId: 1,
    nextAdminId: 1,
  };
}

// Eski ma'lumotlarni yangi tuzilishga moslash
function migrate(db) {
  if (!db.zones) db.zones = [];
  if (!db.messages) db.messages = [];
  if (!db.admins) db.admins = [];
  if (!db.settings) db.settings = {};
  if (!db.nextZoneId) db.nextZoneId = 1;
  if (!db.nextMessageId) db.nextMessageId = 1;
  if (!db.nextAdminId) db.nextAdminId = 1;
  if (!db.places) db.places = [];
  if (!db.nextPlaceId) db.nextPlaceId = 1;
  for (const d of db.drivers) {
    if (!d.carClass) d.carClass = "komfort";
    if (d.zoneId === undefined) d.zoneId = null;
    if (d.queuedAt === undefined) d.queuedAt = null;
    if (d.outsideSince === undefined) d.outsideSince = null;
    if (d.blocked === undefined) d.blocked = false;
    // Ochiq parollarni shifrlash (bir martalik)
    if (d.password && !d.passwordHash) {
      d.passwordHash = bcrypt.hashSync(String(d.password), 10);
      delete d.password;
    }
  }
  // Birinchi admin: login "admin", parol "admin123" — kirgach darhol almashtiring!
  if (db.admins.length === 0) {
    db.admins.push({
      id: db.nextAdminId++,
      username: "admin",
      passwordHash: bcrypt.hashSync("admin123", 10),
    });
    console.log('⚠️  Birinchi admin yaratildi: login "admin", parol "admin123" — darhol almashtiring!');
  }
  return db;
}

// ---------- xotiradagi baza ----------
let cache = null;
let dirty = false;

function readFromDisk() {
  if (!fs.existsSync(DB_FILE)) return defaultData();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function load() {
  if (!cache) {
    cache = migrate(readFromDisk());
    writeNow();
    backupIfNeeded();
  }
  return cache;
}

// O'zgarishni belgilash — faylga keyinroq (2 soniya ichida) yoziladi
function save() {
  dirty = true;
}

function writeNow() {
  if (!cache) return;
  fs.writeFileSync(TMP_FILE, JSON.stringify(cache), "utf-8");
  fs.renameSync(TMP_FILE, DB_FILE); // xavfsiz almashtirish
  dirty = false;
}

setInterval(() => {
  if (dirty) {
    try {
      writeNow();
    } catch (e) {
      console.error("Bazani yozishda xato:", e.message);
    }
  }
}, 2000);

// ---------- kunlik zaxira ----------
function todayStr() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Toshkent sanasi
}

function backupIfNeeded() {
  try {
    const file = path.join(BACKUP_DIR, `data-${todayStr()}.json`);
    if (!fs.existsSync(file) && cache) {
      fs.writeFileSync(file, JSON.stringify(cache), "utf-8");
      console.log("💾 Kunlik zaxira saqlandi:", path.basename(file));
    }
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("data-")).sort();
    while (files.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error("Zaxira xatosi:", e.message);
  }
}
setInterval(backupIfNeeded, 60 * 60 * 1000); // har soatda tekshiradi

// Server to'xtatilganda (Ctrl+C) oxirgi o'zgarishlarni yozib qo'yish
function flushAndExit() {
  try {
    if (dirty) writeNow();
  } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", flushAndExit);
process.on("SIGTERM", flushAndExit);

module.exports = { load, save };
