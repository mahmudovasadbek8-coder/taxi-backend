// routes/places.js — mashhur joylar (Bozor, Maktab...) va internet orqali manzil qidiruvi
const express = require("express");
const router = express.Router();
const { load, save } = require("../db");
const { requireAdmin } = require("../utils/auth");

// GET /api/places — barcha saqlangan joylar
router.get("/", requireAdmin, (req, res) => {
  res.json([...load().places].sort((a, b) => a.name.localeCompare(b.name)));
});

// POST /api/places { name, lat, lng }
router.post("/", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!name) return res.status(400).json({ error: "Joy nomi kerak" });
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "Xaritada joyini belgilang" });
  const db = load();
  if (db.places.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "Bu nomli joy allaqachon bor" });
  }
  const place = { id: db.nextPlaceId++, name, lat, lng };
  db.places.push(place);
  save(db);
  res.status(201).json(place);
});

// DELETE /api/places/:id
router.delete("/:id", requireAdmin, (req, res) => {
  const db = load();
  db.places = db.places.filter((p) => p.id !== Number(req.params.id));
  save(db);
  res.json({ ok: true });
});

// ---------- Internet qidiruvi (OpenStreetMap Nominatim) ----------
// Server orqali so'raladi: to'g'ri identifikator bilan va natijalar 1 kun keshda saqlanadi.
const cache = new Map();
let lastCall = 0;

// GET /api/places/geocode?q=...&lat=..&lng=..  (lat/lng — xarita markazi, yaqin natijalar oldinda)
router.get("/geocode", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.json([]);
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const key = `${q.toLowerCase()}|${isFinite(lat) ? lat.toFixed(1) : ""}|${isFinite(lng) ? lng.toFixed(1) : ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 24 * 3600 * 1000) return res.json(hit.data);

  // Nominatim qoidasi: soniyasiga 1 tadan ko'p emas
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const params = new URLSearchParams({ q, format: "json", limit: "6", countrycodes: "uz", "accept-language": "uz,ru" });
  if (isFinite(lat) && isFinite(lng)) {
    // xarita atrofidagi ~50 km hudud ustun (lekin tashqarisi ham chiqishi mumkin)
    params.set("viewbox", `${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}`);
  }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": "TaxiDispatch/1.0 (taxi dispatch system)" },
    });
    if (!r.ok) throw new Error("Qidiruv xizmati javob bermadi");
    const list = await r.json();
    const data = list.map((x) => ({ name: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }));
    cache.set(key, { t: Date.now(), data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Internet qidiruvi ishlamadi: " + e.message });
  }
});

module.exports = router;
