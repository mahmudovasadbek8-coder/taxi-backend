// utils/auth.js — kirish (token) va ruxsatlarni tekshirish
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { load, save } = require("../db");

// Maxfiy kalit: serverda JWT_SECRET orqali beriladi, bo'lmasa bazada bir marta yaratiladi
function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const db = load();
  if (!db.settings.jwtSecret) {
    db.settings.jwtSecret = crypto.randomBytes(32).toString("hex");
    save(db);
  }
  return db.settings.jwtSecret;
}

function signAdmin(admin) {
  return jwt.sign({ role: "admin", adminId: admin.id }, secret(), { expiresIn: "30d" });
}
function signDriver(driver) {
  return jwt.sign({ role: "driver", driverId: driver.id }, secret(), { expiresIn: "90d" });
}

// Token -> foydalanuvchi (yaroqsiz bo'lsa null)
function verify(token) {
  try {
    const user = jwt.verify(token, secret());
    const db = load();
    if (user.role === "admin" && db.admins.some((a) => a.id === user.adminId)) return user;
    if (user.role === "driver") {
      const d = db.drivers.find((x) => x.id === user.driverId);
      if (d && !d.blocked && !d.deleted) return user;
    }
  } catch (e) {}
  return null;
}

function tokenFrom(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Express middleware'lari
function requireAuth(req, res, next) {
  const user = verify(tokenFrom(req));
  if (!user) return res.status(401).json({ error: "Qaytadan kiring (sessiya tugagan)" });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Faqat dispetcher uchun" });
    next();
  });
}
function requireDriver(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "driver") return res.status(403).json({ error: "Faqat haydovchi uchun" });
    next();
  });
}

module.exports = { signAdmin, signDriver, verify, requireAuth, requireAdmin, requireDriver };
