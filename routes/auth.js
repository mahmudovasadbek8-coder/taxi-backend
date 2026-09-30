// routes/auth.js — dispetcher (admin) kirishi va parolni almashtirish
const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const { load, save } = require("../db");
const { signAdmin, requireAdmin } = require("../utils/auth");

// Ko'p marta noto'g'ri parol kiritishdan himoya (IP bo'yicha, 10 daqiqada 10 urinish)
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordFail(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}

// POST /api/auth/admin-login { username, password }
router.post("/admin-login", (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: "Juda ko'p urinish. 10 daqiqadan keyin qayta urining." });
  const { username, password } = req.body;
  const admin = load().admins.find((a) => a.username === String(username || "").trim());
  if (!admin || !bcrypt.compareSync(String(password || ""), admin.passwordHash)) {
    recordFail(ip);
    return res.status(401).json({ error: "Login yoki parol xato" });
  }
  res.json({ token: signAdmin(admin), username: admin.username });
});

// POST /api/auth/admin-password { oldPassword, newPassword }
router.post("/admin-password", requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const db = load();
  const admin = db.admins.find((a) => a.id === req.user.adminId);
  if (!bcrypt.compareSync(String(oldPassword || ""), admin.passwordHash)) {
    return res.status(400).json({ error: "Eski parol noto'g'ri" });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "Yangi parol kamida 6 belgi bo'lsin" });
  }
  admin.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  save(db);
  res.json({ ok: true });
});

module.exports = { router, recordFail, tooMany };
