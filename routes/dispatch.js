// routes/dispatch.js — dispetcher xabarlari va kunlik yozuvlar
const express = require("express");
const router = express.Router();
const { load, save } = require("../db");
const { localDate, pushMessage } = require("../utils/log");
const { requireAdmin, requireDriver } = require("../utils/auth");

// GET /api/dispatch?date=YYYY-MM-DD — shu kunning barcha yozuvlari (sana bo'lmasa — bugun)
router.get("/", requireAdmin, (req, res) => {
  const date = req.query.date || localDate(new Date().toISOString());
  res.json(load().messages.filter((m) => localDate(m.createdAt) === date));
});

// POST /api/dispatch { body } — admin BARCHA haydovchilarga
router.post("/", requireAdmin, (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: "Xabar bo'sh" });
  const db = load();
  const message = { id: db.nextMessageId++, from: "admin", body, createdAt: new Date().toISOString() };
  pushMessage(db, message);
  save(db);
  const io = req.app.get("io");
  io.to("drivers").emit("dispatch:message", message);
  io.to("admins").emit("log:new", message);
  res.status(201).json(message);
});

// POST /api/dispatch/driver { driverId, body } — haydovchi ADMIN'ga
router.post("/driver", requireDriver, (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: "Xabar bo'sh" });
  const db = load();
  const driver = db.drivers.find((d) => d.id === req.user.driverId); // haydovchi — tokendan
  if (!driver) return res.status(404).json({ error: "Haydovchi topilmadi" });
  const message = {
    id: db.nextMessageId++,
    from: "driver",
    driverId: driver.id,
    driverName: driver.name,
    body,
    createdAt: new Date().toISOString(),
  };
  pushMessage(db, message);
  save(db);
  req.app.get("io").to("admins").emit("log:new", message);
  res.status(201).json({ ok: true });
});

module.exports = router;
