// routes/drivers.js — haydovchilar
const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const { load, save } = require("../db");
const { notifyQueues, updateZoneMembership, clearZone } = require("../utils/queue");
const { signDriver, requireAuth, requireAdmin, requireDriver } = require("../utils/auth");
const { recordFail, tooMany } = require("./auth");

function safe(d) {
  const { password, passwordHash, ...rest } = d;
  return rest;
}
function findDriver(db, id) {
  return db.drivers.find((d) => d.id === Number(id));
}
// Haydovchi faqat o'zini, admin esa hammani boshqara oladi
function selfOrAdmin(req, id) {
  return req.user.role === "admin" || req.user.driverId === Number(id);
}

// ---------- kirish ----------

// POST /api/drivers/login { phone, password } -> { ...driver, token }
router.post("/login", (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: "Juda ko'p urinish. 10 daqiqadan keyin qayta urining." });
  const { phone, password } = req.body;
  const db = load();
  const driver = db.drivers.find((d) => !d.deleted && d.phone === String(phone || "").trim());
  if (!driver || !bcrypt.compareSync(String(password || ""), driver.passwordHash || "")) {
    recordFail(ip);
    return res.status(401).json({ error: "Telefon raqam yoki parol xato" });
  }
  if (driver.blocked) return res.status(403).json({ error: "Hisobingiz bloklangan. Dispetcherga murojaat qiling." });
  res.json({ ...safe(driver), token: signDriver(driver) });
});

// GET /api/drivers/me — haydovchi o'z ma'lumotlari (ilova qayta ochilganda avtomatik kirish)
router.get("/me", requireDriver, (req, res) => {
  res.json(safe(findDriver(load(), req.user.driverId)));
});

// ---------- admin: boshqaruv ----------

// GET /api/drivers — barcha haydovchilar
router.get("/", requireAdmin, (req, res) => {
  res.json(load().drivers.filter((d) => !d.deleted).map(safe));
});

// POST /api/drivers { name, phone, password, carClass, carModel, carNumber }
router.post("/", requireAdmin, (req, res) => {
  const { name, phone, password, carClass, carModel, carNumber } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: "Ism, telefon va parol majburiy" });
  }
  const db = load();
  if (db.drivers.some((d) => !d.deleted && d.phone === String(phone).trim())) {
    return res.status(409).json({ error: "Bu telefon raqamli haydovchi allaqachon bor" });
  }
  const driver = {
    id: db.nextDriverId++,
    name: String(name).trim(),
    phone: String(phone).trim(),
    passwordHash: bcrypt.hashSync(String(password), 10),
    carClass: carClass === "damas" ? "damas" : "komfort",
    carModel: carModel || "",
    carNumber: carNumber || "",
    status: "offline",
    lat: null,
    lng: null,
    credit: 0,
    zoneId: null,
    queuedAt: null,
    outsideSince: null,
    blocked: false,
    updatedAt: new Date().toISOString(),
  };
  db.drivers.push(driver);
  save(db);
  res.status(201).json(safe(driver));
});

// PATCH /api/drivers/:id { name, phone, carClass, carModel, carNumber, password? } — tahrirlash
router.patch("/:id", requireAdmin, (req, res) => {
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d) return res.status(404).json({ error: "Haydovchi topilmadi" });
  const { name, phone, carClass, carModel, carNumber, password } = req.body;
  if (phone && db.drivers.some((x) => !x.deleted && x.id !== d.id && x.phone === String(phone).trim())) {
    return res.status(409).json({ error: "Bu telefon raqam boshqa haydovchida bor" });
  }
  if (name) d.name = String(name).trim();
  if (phone) d.phone = String(phone).trim();
  if (carClass) d.carClass = carClass === "damas" ? "damas" : "komfort";
  if (carModel !== undefined) d.carModel = carModel;
  if (carNumber !== undefined) d.carNumber = carNumber;
  if (password) d.passwordHash = bcrypt.hashSync(String(password), 10); // parolni tiklash
  save(db);
  res.json(safe(d));
});

// POST /api/drivers/:id/block { blocked: true|false }
router.post("/:id/block", requireAdmin, (req, res) => {
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d) return res.status(404).json({ error: "Haydovchi topilmadi" });
  d.blocked = !!req.body.blocked;
  const io = req.app.get("io");
  if (d.blocked) {
    d.status = "offline";
    clearZone(d);
    io.to(`driver_${d.id}`).emit("driver:blocked");
    io.to("admins").emit("driver:status", { id: d.id, status: d.status });
    notifyQueues(io);
  }
  save(db);
  res.json(safe(d));
});

// DELETE /api/drivers/:id — ishdan ketgan haydovchini o'chirish.
// Ro'yxatdan yo'qoladi va kira olmaydi, lekin eski buyurtmalari va hisobotlari saqlanadi.
router.delete("/:id", requireAdmin, (req, res) => {
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d || d.deleted) return res.status(404).json({ error: "Haydovchi topilmadi" });
  if (d.status === "busy") {
    return res.status(409).json({ error: "Haydovchi hozir buyurtmada. Avval buyurtma tugasin yoki bekor qilinsin." });
  }
  d.deleted = true;
  d.deletedAt = new Date().toISOString();
  d.status = "offline";
  clearZone(d);
  save(db);
  const io = req.app.get("io");
  io.to(`driver_${d.id}`).emit("driver:blocked"); // ilovadan chiqarib yuboriladi
  notifyQueues(io);
  res.json({ ok: true });
});

// POST /api/drivers/:id/credit { amount } — balans qo'shish
router.post("/:id/credit", requireAdmin, (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== "number" || !isFinite(amount)) {
    return res.status(400).json({ error: "Summa raqam bo'lishi kerak" });
  }
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d) return res.status(404).json({ error: "Haydovchi topilmadi" });
  d.credit += amount;
  save(db);
  const io = req.app.get("io");
  io.to("admins").emit("driver:credit", { id: d.id, credit: d.credit });
  io.to(`driver_${d.id}`).emit("driver:credit", { credit: d.credit });
  res.json({ ok: true, credit: d.credit });
});

// ---------- haydovchi: joylashuv va holat ----------

// PATCH /api/drivers/:id/location { lat, lng }
router.patch("/:id/location", requireAuth, (req, res) => {
  if (!selfOrAdmin(req, req.params.id)) return res.status(403).json({ error: "Ruxsat yo'q" });
  const { lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Joylashuv noto'g'ri" });
  }
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d) return res.status(404).json({ error: "Haydovchi topilmadi" });
  d.lat = lat;
  d.lng = lng;
  d.updatedAt = new Date().toISOString();
  const queueChanged = updateZoneMembership(db, d); // stoyanka doirasini GPS bo'yicha aniqlash
  save(db);
  const io = req.app.get("io");
  io.to("admins").emit("driver:location", { id: d.id, lat, lng, status: d.status });
  if (queueChanged) notifyQueues(io);
  res.json({ ok: true });
});

// PATCH /api/drivers/:id/status { status } — available | offline
router.patch("/:id/status", requireAuth, (req, res) => {
  if (!selfOrAdmin(req, req.params.id)) return res.status(403).json({ error: "Ruxsat yo'q" });
  const { status } = req.body;
  if (!["available", "offline"].includes(status)) return res.status(400).json({ error: "Noto'g'ri holat" });
  const db = load();
  const d = findDriver(db, req.params.id);
  if (!d) return res.status(404).json({ error: "Haydovchi topilmadi" });
  if (d.status === "busy") return res.status(409).json({ error: "Avval joriy buyurtmani tugating" });
  d.status = status;
  if (status === "offline") clearZone(d); // oflayn bo'lsa navbatdan chiqadi
  if (status === "available") updateZoneMembership(db, d);
  save(db);
  const io = req.app.get("io");
  io.to("admins").emit("driver:status", { id: d.id, status });
  notifyQueues(io);
  res.json({ ok: true });
});

// GET /api/drivers/:id/stats — kunlik hisobot (oxirgi 30 kun, O'zbekiston vaqti bilan)
router.get("/:id/stats", requireAuth, (req, res) => {
  if (!selfOrAdmin(req, req.params.id)) return res.status(403).json({ error: "Ruxsat yo'q" });
  const id = Number(req.params.id);
  const db = load();
  const TZ = 5 * 3600 * 1000;
  const days = {};
  for (const o of db.orders) {
    if (o.driverId !== id || o.status !== "finished" || !o.finishedAt) continue;
    const key = new Date(new Date(o.finishedAt).getTime() + TZ).toISOString().slice(0, 10);
    if (!days[key]) days[key] = { count: 0, total: 0, fee: 0 };
    days[key].count += 1;
    days[key].total += o.fare || 0;
    days[key].fee += o.fee || 0;
  }
  const list = Object.entries(days)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 30)
    .map(([k, v]) => ({ date: `${k.slice(8, 10)}.${k.slice(5, 7)}.${k.slice(0, 4)}`, ...v }));
  const todayKey = new Date(Date.now() + TZ).toISOString().slice(0, 10);
  res.json({ today: days[todayKey] || { count: 0, total: 0, fee: 0 }, days: list });
});

module.exports = router;
