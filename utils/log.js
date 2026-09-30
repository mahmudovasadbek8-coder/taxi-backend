// utils/log.js — admin uchun kunlik yozuvlar (xabarlar va hodisalar bazada saqlanadi)
const TZ = 5 * 3600 * 1000; // UTC+5 (Toshkent)
const MAX_MESSAGES = 5000; // bazada saqlanadigan eng ko'p yozuv

// ISO vaqtdan Toshkent sanasi: "YYYY-MM-DD"
function localDate(iso) {
  return new Date(new Date(iso).getTime() + TZ).toISOString().slice(0, 10);
}

function pushMessage(db, msg) {
  db.messages.push(msg);
  if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
}

// Tizim hodisasini yozish va admin'ga yuborish (chaqiruvchi keyin save(db) qiladi)
function notice(db, io, text, alert = false) {
  const msg = { id: db.nextMessageId++, from: "system", body: text, alert, createdAt: new Date().toISOString() };
  pushMessage(db, msg);
  io.to("admins").emit("log:new", msg);
}

module.exports = { localDate, pushMessage, notice, TZ };
