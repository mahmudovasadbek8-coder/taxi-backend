// routes/stats.js — eng faol haydovchilar va mijoz tarixi
const express = require("express");
const router = express.Router();
const { load } = require("../db");
const { requireAdmin } = require("../utils/auth");

const TZ = 5 * 3600 * 1000; // Toshkent vaqti
function localDate(iso) {
  return new Date(new Date(iso).getTime() + TZ).toISOString().slice(0, 10);
}
// Telefon raqamini solishtirish uchun: faqat oxirgi 9 ta raqam (+998 bo'lsa ham, bo'lmasa ham bir xil)
function phoneKey(p) {
  return String(p || "").replace(/\D/g, "").slice(-9);
}

// GET /api/stats/top?period=today|month — eng ko'p buyurtma bajargan haydovchilar
router.get("/top", requireAdmin, (req, res) => {
  const db = load();
  const today = localDate(new Date().toISOString());
  const month = today.slice(0, 7);
  const period = req.query.period === "month" ? "month" : "today";
  const rows = {};
  for (const o of db.orders) {
    if (o.status !== "finished" || !o.finishedAt || !o.driverId) continue;
    const day = localDate(o.finishedAt);
    if (period === "today" ? day !== today : day.slice(0, 7) !== month) continue;
    if (!rows[o.driverId]) rows[o.driverId] = { count: 0, total: 0 };
    rows[o.driverId].count += 1;
    rows[o.driverId].total += o.fare || 0;
  }
  const list = Object.entries(rows)
    .map(([id, v]) => {
      const d = db.drivers.find((x) => x.id === Number(id));
      return {
        id: Number(id),
        name: d ? d.name : "—",
        carNumber: d ? d.carNumber : "",
        deleted: d ? !!d.deleted : true,
        ...v,
      };
    })
    .sort((a, b) => b.count - a.count || b.total - a.total)
    .slice(0, 20);
  res.json(list);
});

// GET /api/stats/customer/:phone — mijozning oldingi manzillari (eng oxirgisi birinchi)
router.get("/customer/:phone", requireAdmin, (req, res) => {
  const key = phoneKey(req.params.phone);
  if (key.length < 7) return res.json({ count: 0, addresses: [] });
  const db = load();
  const orders = db.orders
    .filter((o) => phoneKey(o.customerPhone) === key)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const seen = new Set();
  const addresses = [];
  for (const o of orders) {
    const k = String(o.customerAddress || "").trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    addresses.push({ address: o.customerAddress, lat: o.customerLat, lng: o.customerLng, date: o.createdAt });
    if (addresses.length >= 8) break;
  }
  res.json({ count: orders.length, addresses });
});

module.exports = router;
