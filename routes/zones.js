// routes/zones.js — stoyankalar: xaritada doira (markaz + radius)
const express = require("express");
const router = express.Router();
const { load, save } = require("../db");
const { zonesWithQueues, notifyQueues } = require("../utils/queue");
const { requireAuth, requireAdmin } = require("../utils/auth");

// GET /api/zones — barcha stoyankalar va navbatlar
router.get("/", requireAuth, (req, res) => {
  res.json(zonesWithQueues(load()));
});

// POST /api/zones { name, lat, lng, radius } — operator xaritada belgilaydi
router.post("/", requireAdmin, (req, res) => {
  const name = (req.body.name || "").trim();
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const radius = Number(req.body.radius) || 300;
  if (!name) return res.status(400).json({ error: "Stoyanka nomi kerak" });
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "Xaritada joyini belgilang" });
  const db = load();
  if (db.zones.some((z) => z.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "Bu nomli stoyanka bor" });
  }
  const zone = { id: db.nextZoneId++, name, lat, lng, radius };
  db.zones.push(zone);
  save(db);
  notifyQueues(req.app.get("io"));
  res.status(201).json(zone);
});

// DELETE /api/zones/:id
router.delete("/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const db = load();
  db.zones = db.zones.filter((z) => z.id !== id);
  for (const d of db.drivers) {
    if (d.zoneId === id) {
      d.zoneId = null;
      d.queuedAt = null;
      d.outsideSince = null;
    }
  }
  save(db);
  notifyQueues(req.app.get("io"));
  res.json({ ok: true });
});

module.exports = router;
