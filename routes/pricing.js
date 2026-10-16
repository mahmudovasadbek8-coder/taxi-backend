// routes/pricing.js — narxlarni admin boshqaradi: asosiy narxlar, tariflar, qo'shimchalar
const express = require("express");
const router = express.Router();
const { load, save } = require("../db");
const { requireAdmin, requireAuth } = require("../utils/auth");
const { getPricing, DEFAULT_PRICING } = require("../utils/pricing");
const { notice } = require("../utils/log");

const MODES = ["any", "class", "nearest"];
const MODE_NAMES = { any: "istalgan mashina", class: "faqat shu turdagi mashina", nearest: "eng yaqin mashina" };
const money = (n) => Number(n).toLocaleString("ru-RU") + " so'm";

// GET /api/pricing — hammasi bir joyda (admin va haydovchi ilovasi uchun)
router.get("/", requireAuth, (req, res) => {
  const db = load();
  res.json({ settings: getPricing(db), tariffs: db.tariffs, extras: db.extras });
});

// PUT /api/pricing/settings { baseFare, perKm, freeWaitSec, waitStepSec, waitStepPrice }
router.put("/settings", requireAdmin, (req, res) => {
  const db = load();
  const old = getPricing(db);
  const next = { ...old };
  const labels = {
    baseFare: "Asosiy boshlash narxi",
    perKm: "1 km narxi",
    freeWaitSec: "Bepul kutish (soniya)",
    waitStepSec: "Kutish qadami (soniya)",
    waitStepPrice: "Kutish qadami narxi",
  };
  const changes = [];
  for (const k of Object.keys(DEFAULT_PRICING)) {
    if (req.body[k] === undefined || req.body[k] === "") continue;
    const v = Number(req.body[k]);
    if (!isFinite(v) || v < 0) return res.status(400).json({ error: `${labels[k]} noto'g'ri` });
    if (k === "waitStepSec" && v < 1) return res.status(400).json({ error: "Kutish qadami kamida 1 soniya" });
    if (v !== old[k]) changes.push(`${labels[k]}: ${old[k]} → ${v}`);
    next[k] = v;
  }
  db.settings.pricing = next;
  if (changes.length) notice(db, req.app.get("io"), `💰 Narx o'zgardi — ${changes.join(", ")}`);
  save(db);
  res.json(next);
});

// ---------- tariflar ----------
function slugKey(db) {
  return "t" + db.nextTariffId;
}

// POST /api/pricing/tariffs { name, mode, extra }
router.post("/tariffs", requireAdmin, (req, res) => {
  const db = load();
  const name = String(req.body.name || "").trim();
  const mode = req.body.mode;
  const extra = Number(req.body.extra) || 0;
  if (!name) return res.status(400).json({ error: "Tarif nomi kerak" });
  if (!MODES.includes(mode)) return res.status(400).json({ error: "Tarif turi noto'g'ri" });
  if (db.tariffs.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "Bu nomli tarif bor" });
  }
  const t = { id: db.nextTariffId, key: slugKey(db), name, mode, extra };
  db.nextTariffId++;
  db.tariffs.push(t);
  notice(db, req.app.get("io"), `💰 Yangi tarif: ${name} (+${money(extra)}, ${MODE_NAMES[mode]})`);
  save(db);
  res.status(201).json(t);
});

// PATCH /api/pricing/tariffs/:id { name, extra, mode }
router.patch("/tariffs/:id", requireAdmin, (req, res) => {
  const db = load();
  const t = db.tariffs.find((x) => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: "Tarif topilmadi" });
  const changes = [];
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Tarif nomi kerak" });
    if (db.tariffs.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: "Bu nomli tarif bor" });
    }
    if (name !== t.name) changes.push(`nomi: ${t.name} → ${name}`);
    t.name = name;
  }
  if (req.body.extra !== undefined) {
    const extra = Number(req.body.extra);
    if (!isFinite(extra)) return res.status(400).json({ error: "Qo'shimcha narx noto'g'ri" });
    if (extra !== t.extra) changes.push(`+${money(t.extra)} → +${money(extra)}`);
    t.extra = extra;
  }
  if (req.body.mode !== undefined && !t.system) {
    if (!MODES.includes(req.body.mode)) return res.status(400).json({ error: "Tarif turi noto'g'ri" });
    if (t.mode === "class" && req.body.mode !== "class" && db.drivers.some((d) => !d.deleted && d.carClass === t.key)) {
      return res.status(409).json({ error: "Bu turdagi haydovchilar bor — turini o'zgartirib bo'lmaydi" });
    }
    t.mode = req.body.mode;
  }
  if (changes.length) notice(db, req.app.get("io"), `💰 Tarif "${t.name}" o'zgardi — ${changes.join(", ")}`);
  save(db);
  res.json(t);
});

// DELETE /api/pricing/tariffs/:id
router.delete("/tariffs/:id", requireAdmin, (req, res) => {
  const db = load();
  const t = db.tariffs.find((x) => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: "Tarif topilmadi" });
  if (t.system) return res.status(409).json({ error: `"${t.name}" asosiy tarif — o'chirib bo'lmaydi` });
  const used = db.drivers.filter((d) => !d.deleted && d.carClass === t.key).length;
  if (used) return res.status(409).json({ error: `Bu turdagi ${used} ta haydovchi bor. Avval ularning mashina turini o'zgartiring.` });
  db.tariffs = db.tariffs.filter((x) => x.id !== t.id);
  notice(db, req.app.get("io"), `💰 Tarif o'chirildi: ${t.name}`);
  save(db);
  res.json({ ok: true });
});

// ---------- qo'shimchalar ("Mashina tortish +10 000") ----------

// POST /api/pricing/extras { name, price }
router.post("/extras", requireAdmin, (req, res) => {
  const db = load();
  const name = String(req.body.name || "").trim();
  const price = Number(req.body.price);
  if (!name) return res.status(400).json({ error: "Nomi kerak" });
  if (!isFinite(price)) return res.status(400).json({ error: "Narx noto'g'ri" });
  if (db.extras.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "Bu nomli qo'shimcha bor" });
  }
  const e = { id: db.nextExtraId++, name, price };
  db.extras.push(e);
  notice(db, req.app.get("io"), `💰 Yangi qo'shimcha: ${name} (+${money(price)})`);
  save(db);
  res.status(201).json(e);
});

// PATCH /api/pricing/extras/:id { name, price }
router.patch("/extras/:id", requireAdmin, (req, res) => {
  const db = load();
  const e = db.extras.find((x) => x.id === Number(req.params.id));
  if (!e) return res.status(404).json({ error: "Topilmadi" });
  const changes = [];
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Nomi kerak" });
    if (db.extras.some((x) => x.id !== e.id && x.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: "Bu nomli qo'shimcha bor" });
    }
    if (name !== e.name) changes.push(`nomi: ${e.name} → ${name}`);
    e.name = name;
  }
  if (req.body.price !== undefined) {
    const price = Number(req.body.price);
    if (!isFinite(price)) return res.status(400).json({ error: "Narx noto'g'ri" });
    if (price !== e.price) changes.push(`+${money(e.price)} → +${money(price)}`);
    e.price = price;
  }
  if (changes.length) notice(db, req.app.get("io"), `💰 Qo'shimcha "${e.name}" o'zgardi — ${changes.join(", ")}`);
  save(db);
  res.json(e);
});

// DELETE /api/pricing/extras/:id
router.delete("/extras/:id", requireAdmin, (req, res) => {
  const db = load();
  const e = db.extras.find((x) => x.id === Number(req.params.id));
  if (!e) return res.status(404).json({ error: "Topilmadi" });
  db.extras = db.extras.filter((x) => x.id !== e.id);
  notice(db, req.app.get("io"), `💰 Qo'shimcha o'chirildi: ${e.name}`);
  save(db);
  res.json({ ok: true });
});

module.exports = router;
