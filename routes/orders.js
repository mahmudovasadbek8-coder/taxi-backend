// routes/orders.js — buyurtmalar: taklif, 15 soniya, navbat, efir
const express = require("express");
const router = express.Router();
const { load, save } = require("../db");
const { distanceKm, calcFare } = require("../utils/distance");
const { zoneQueue, notifyQueues, clearZone } = require("../utils/queue");
const { notice } = require("../utils/log");
const { requireAuth, requireAdmin, requireDriver } = require("../utils/auth");

// ===== SOZLAMALAR =====
const ORDER_FEE = 2000; // har bajarilgan buyurtmadan yechiladigan summa (so'm)
const REQUIRE_BALANCE = true; // balansi yetmaganga buyurtma yuborilmaydi
const OFFER_SECONDS = 15; // haydovchi shu vaqt ichida qabul qilmasa — keyingisiga o'tadi

const ACTIVE = ["open", "assigned", "accepted", "arrived", "ongoing"];

// Haydovchiga yuboriladigan ko'rinish: ichki ma'lumotlar (boshqa haydovchilar ro'yxati) olib tashlanadi
function driverView(order) {
  const { triedDriverIds, assignMethod, ...rest } = order;
  return rest;
}

function canTake(d, order) {
  return (
    (!REQUIRE_BALANCE || (d.credit || 0) >= ORDER_FEE) &&
    (!order.requestedClass || d.carClass === order.requestedClass)
  );
}

// Keyingi mos haydovchini topish: 1) stoyanka navbati  2) eng yaqin  3) eng uzoq kutgan
function findDriver(db, order) {
  const tried = order.triedDriverIds || [];
  const fits = (d) => d.status === "available" && !tried.includes(d.id) && canTake(d, order);

  if (order.zoneId) {
    // doiradan vaqtincha chiqib turganlar o'tkazib yuboriladi (joyi saqlanadi)
    const d = zoneQueue(db, order.zoneId).find((x) => fits(x) && !x.outsideSince);
    if (d) return { driver: d, method: "navbat", dist: null };
  }
  const candidates = db.drivers.filter(fits);
  if (order.customerLat != null && order.customerLng != null) {
    let best = null;
    let bestDist = null;
    for (const d of candidates) {
      if (d.lat == null || d.lng == null) continue;
      const km = distanceKm(order.customerLat, order.customerLng, d.lat, d.lng);
      if (bestDist === null || km < bestDist) {
        bestDist = km;
        best = d;
      }
    }
    if (best) return { driver: best, method: "eng yaqin", dist: bestDist };
  }
  if (candidates.length) {
    const d = [...candidates].sort(
      (a, b) => new Date(a.queuedAt || a.updatedAt) - new Date(b.queuedAt || b.updatedAt)
    )[0];
    return { driver: d, method: "eng yaqin", dist: null };
  }
  return { driver: null };
}

// Buyurtmani keyingi haydovchiga taklif qilish, hech kim bo'lmasa — efirga chiqarish
function offer(db, io, order) {
  const { driver, method, dist } = findDriver(db, order);
  if (driver) {
    order.driverId = driver.id;
    order.status = "assigned";
    order.assignMethod = method;
    order.distanceKm = dist;
    order.carClass = driver.carClass; // qaysi mashina borayotgani (ko'rsatish uchun)
    order.offerExpiresAt = new Date(Date.now() + OFFER_SECONDS * 1000).toISOString();
    driver.status = "busy";
    io.to(`driver_${driver.id}`).emit("order:new", { ...driverView(order), offerSeconds: OFFER_SECONDS });
    io.to("admins").emit("driver:status", { id: driver.id, status: driver.status });
  } else {
    order.driverId = null;
    order.status = "open"; // EFIR — hamma ko'radi, istalgan haydovchi oladi
    order.assignMethod = "efir";
    order.carClass = order.requestedClass || null;
    order.offerExpiresAt = null;
    io.to("drivers").emit("order:open", driverView(order));
    notice(db, io, `📢 Buyurtma #${order.id} efirga chiqdi (bo'sh haydovchi yo'q)`);
  }
  io.to("admins").emit("order:updated", order);
  notifyQueues(io);
}

// Haydovchini bo'shatish. Navbatdagi joyi SAQLANADI (queuedAt o'zgarmaydi) —
// haydovchi faqat buyurtmani olib ketganda navbatdan chiqadi.
function releaseDriver(io, driver) {
  driver.status = "available";
  io.to("admins").emit("driver:status", { id: driver.id, status: driver.status });
}

// 15 soniya tugagan takliflarni tekshirib turuvchi (har 2 soniyada)
function startOfferSweeper(io) {
  setInterval(() => {
    const db = load();
    const now = Date.now();
    let changed = false;
    for (const o of db.orders) {
      if (o.status !== "assigned" || !o.offerExpiresAt) continue;
      if (new Date(o.offerExpiresAt).getTime() > now) continue;
      const d = db.drivers.find((x) => x.id === o.driverId);
      if (d) {
        releaseDriver(io, d); // javob bermadi — joyi saqlanadi, buyurtma keyingisiga
        io.to(`driver_${d.id}`).emit("order:expired", { id: o.id });
        notice(db, io, `⏳ ${d.name} #${o.id} ga 15 soniyada javob bermadi — keyingisiga o'tdi`);
      }
      o.triedDriverIds = [...(o.triedDriverIds || []), o.driverId];
      offer(db, io, o);
      changed = true;
    }
    if (changed) save(db);
  }, 2000);
}

// ---------- ro'yxatlar ----------
router.get("/active", requireAdmin, (req, res) => {
  res.json(load().orders.filter((o) => ACTIVE.includes(o.status)));
});
router.get("/open", requireAuth, (req, res) => {
  res.json(load().orders.filter((o) => o.status === "open").map(driverView));
});
router.get("/", requireAdmin, (req, res) => {
  res.json(load().orders);
});

// POST /api/orders — admin yangi buyurtma
// body: { customerPhone, customerAddress, customerLat, customerLng, carClass, zoneId }
router.post("/", requireAdmin, (req, res) => {
  const { customerPhone, customerAddress, customerLat, customerLng } = req.body;
  if (!customerPhone || !customerAddress) {
    return res.status(400).json({ error: "Mijoz telefoni va manzili majburiy" });
  }
  const db = load();
  const order = {
    id: db.nextOrderId++,
    customerPhone,
    customerAddress,
    customerLat: customerLat ?? null,
    customerLng: customerLng ?? null,
    requestedClass: req.body.carClass || null,
    fareClass: req.body.carClass || null, // narx turi: null = "farqi yo'q" (5000 dan)
    carClass: req.body.carClass || null,
    zoneId: req.body.zoneId ? Number(req.body.zoneId) : null,
    triedDriverIds: [],
    assignMethod: null,
    driverId: null,
    status: "new",
    distanceKm: null,
    tripDistanceKm: 0,
    lastTrackPoint: null,
    fare: null,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    arrivedAt: null,
    startedAt: null,
    finishedAt: null,
  };
  db.orders.push(order);
  offer(db, req.app.get("io"), order);
  save(db);
  res.status(201).json(order);
});

// POST /api/orders/:id/take { driverId } — efirdagi buyurtmani olish
router.post("/:id/take", requireDriver, (req, res) => {
  const db = load();
  const order = db.orders.find((o) => o.id === Number(req.params.id));
  const driver = db.drivers.find((d) => d.id === req.user.driverId); // haydovchi — tokendan
  if (!order || !driver) return res.status(404).json({ error: "Topilmadi" });
  if (order.status !== "open") {
    return res.status(409).json({ error: "Bu buyurtmani boshqa haydovchi oldi" });
  }
  if (driver.status === "busy") {
    return res.status(409).json({ error: "Avval joriy buyurtmangizni tugating" });
  }
  if (!canTake(driver, order)) {
    return res.status(403).json({
      error: order.requestedClass && driver.carClass !== order.requestedClass
        ? "Bu buyurtma boshqa turdagi mashina uchun"
        : `Balans yetarli emas (kamida ${ORDER_FEE} so'm)`,
    });
  }
  const now = new Date().toISOString();
  order.driverId = driver.id;
  order.status = "accepted";
  order.acceptedAt = now;
  order.carClass = driver.carClass;
  order.offerExpiresAt = null;
  driver.status = "busy";
  clearZone(driver);
  save(db);

  const io = req.app.get("io");
  io.to("drivers").emit("order:closed", { id: order.id });
  io.to("admins").emit("order:updated", order);
  io.to("admins").emit("driver:status", { id: driver.id, status: driver.status });
  notifyQueues(io);
  res.json(order);
});

// POST /api/orders/street { driverId, lat, lng } — ko'chadan yo'lovchi
router.post("/street", requireDriver, (req, res) => {
  const { lat, lng } = req.body;
  const db = load();
  const driver = db.drivers.find((d) => d.id === req.user.driverId); // haydovchi — tokendan
  if (!driver) return res.status(404).json({ error: "Haydovchi topilmadi" });
  if (driver.status === "busy") {
    return res.status(409).json({ error: "Sizda tugallanmagan buyurtma bor" });
  }
  if (REQUIRE_BALANCE && (driver.credit || 0) < ORDER_FEE) {
    return res.status(402).json({ error: `Balans yetarli emas (kamida ${ORDER_FEE} so'm kerak)` });
  }
  const now = new Date().toISOString();
  const order = {
    id: db.nextOrderId++,
    customerPhone: "—",
    customerAddress: "Ko'chadan olingan yo'lovchi",
    customerLat: lat ?? null,
    customerLng: lng ?? null,
    requestedClass: null,
    fareClass: driver.carClass, // ko'chadan — mijoz mashinani o'zi tanlab o'tirdi
    carClass: driver.carClass,
    zoneId: null,
    triedDriverIds: [],
    assignMethod: "ko'cha",
    driverId: driver.id,
    status: "ongoing",
    distanceKm: 0,
    tripDistanceKm: 0,
    lastTrackPoint: lat != null && lng != null ? { lat, lng } : null,
    fare: null,
    createdAt: now,
    acceptedAt: now,
    arrivedAt: now,
    startedAt: now,
    finishedAt: null,
  };
  db.orders.push(order);
  driver.status = "busy";
  clearZone(driver);
  save(db);

  const io = req.app.get("io");
  io.to("admins").emit("order:created", order);
  io.to("admins").emit("driver:status", { id: driver.id, status: driver.status });
  notifyQueues(io);
  res.status(201).json(order);
});

// PATCH /api/orders/:id/track { lat, lng, idleSeconds } — taksometr
// Telefon faqat mashina HARAKATDA bo'lganda nuqta yuboradi (GPS "sakrashi" hisoblanmaydi),
// to'xtab turganda esa faqat idleSeconds (to'xtash vaqti) yuboradi.
router.patch("/:id/track", requireDriver, (req, res) => {
  const { lat, lng, idleSeconds } = req.body;
  const db = load();
  const order = db.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.driverId !== req.user.driverId) return res.status(403).json({ error: "Bu sizning buyurtmangiz emas" });
  if (order.status !== "ongoing") return res.json({ ok: true, ignored: true });
  if (typeof idleSeconds === "number") {
    order.tripIdleSeconds = Math.max(order.tripIdleSeconds || 0, idleSeconds);
  }
  if (lat == null || lng == null) {
    save(db);
    return res.json({ ok: true });
  }
  if (order.lastTrackPoint) {
    order.tripDistanceKm =
      (order.tripDistanceKm || 0) +
      distanceKm(order.lastTrackPoint.lat, order.lastTrackPoint.lng, lat, lng);
  }
  order.lastTrackPoint = { lat, lng };
  save(db);
  req.app.get("io").to("admins").emit("order:updated", order);
  res.json({ ok: true, tripDistanceKm: order.tripDistanceKm });
});

// PATCH /api/orders/:id/status { status, driverId }
// Haydovchi: accepted | rejected | arrived | ongoing | finished | transfer | driver_cancelled
// Admin:     cancelled
router.patch("/:id/status", requireAuth, (req, res) => {
  const { status } = req.body;
  // Kim o'zgartiryapti — tokendan olinadi (body'dagi driverId'ga ishonilmaydi)
  const byDriver = req.user.role === "driver" ? req.user.driverId : null;
  const DRIVER_STATUSES = ["accepted", "rejected", "arrived", "ongoing", "finished", "transfer", "driver_cancelled"];
  if (byDriver === null && status !== "cancelled") {
    return res.status(403).json({ error: "Dispetcher faqat bekor qila oladi" });
  }
  if (byDriver !== null && !DRIVER_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Noto'g'ri holat" });
  }
  const db = load();
  const order = db.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });

  // Buyurtma allaqachon boshqa haydovchiga o'tgan bo'lsa (masalan 15 soniya tugagan)
  if (byDriver !== null && order.driverId !== byDriver) {
    return res.status(409).json({ error: "Vaqt tugadi — buyurtma boshqa haydovchiga o'tdi" });
  }
  if (status === "accepted" && order.status !== "assigned") {
    return res.status(409).json({ error: "Bu buyurtma endi mavjud emas" });
  }

  const io = req.app.get("io");
  const driver = db.drivers.find((d) => d.id === order.driverId);
  const now = new Date().toISOString();

  if (status === "rejected" || status === "transfer") {
    // Rad etdi / boshqaga o'tkazdi — keyingi haydovchiga avtomatik
    if (driver) releaseDriver(io, driver); // navbatdagi joyi saqlanadi
    if (status === "rejected" && driver) {
      notice(db, io, `⏭ ${driver.name} #${order.id} ni o'tkazib yubordi — keyingisiga o'tdi`);
    }
    order.triedDriverIds = [...(order.triedDriverIds || []), order.driverId];
    if (status === "transfer") {
      order.acceptedAt = null;
      order.arrivedAt = null;
      notice(db, io, `↪ ${driver ? driver.name : "Haydovchi"} buyurtma #${order.id} ni boshqaga o'tkazdi`);
    }
    offer(db, io, order);
    save(db);
    return res.json(order);
  }

  order.status = status;
  if (status === "accepted") {
    order.acceptedAt = now;
    order.offerExpiresAt = null;
    if (driver) clearZone(driver); // buyurtmani oldi — navbatdan chiqdi
  }
  if (status === "arrived") order.arrivedAt = now;
  if (status === "ongoing") {
    order.startedAt = now;
    order.tripDistanceKm = 0;
    order.tripIdleSeconds = 0;
    order.lastTrackPoint = null;
  }
  if (status === "finished") {
    order.finishedAt = now;
    if (typeof req.body.idleSeconds === "number") {
      order.tripIdleSeconds = Math.max(order.tripIdleSeconds || 0, req.body.idleSeconds);
    }
    // Kutish = mijozni kutish ("Yetib keldim" -> "Safarni boshlash") + safar paytidagi to'xtashlar
    const preWaitSec =
      order.arrivedAt && order.startedAt
        ? Math.max(0, (new Date(order.startedAt) - new Date(order.arrivedAt)) / 1000)
        : 0;
    order.waitSeconds = Math.round(preWaitSec + (order.tripIdleSeconds || 0));
    const fareClass = "fareClass" in order ? order.fareClass : order.carClass;
    order.fare = calcFare(order.tripDistanceKm || 0, fareClass, order.waitSeconds);
    order.fee = ORDER_FEE;
    if (driver) {
      driver.status = "available";
      clearZone(driver);
      driver.credit = (driver.credit || 0) - ORDER_FEE; // komissiya
      io.to("admins").emit("driver:credit", { id: driver.id, credit: driver.credit });
      io.to(`driver_${driver.id}`).emit("driver:credit", { credit: driver.credit });
      notice(db, io, `✅ ${driver.name} #${order.id} ni tugatdi — ${order.fare.toLocaleString()} so'm`);
    }
  }
  if (status === "driver_cancelled") {
    // Mijoz chiqmadi — haydovchi bekor qildi
    if (driver) releaseDriver(io, driver);
    notice(db, io, `⚠️ ${driver ? driver.name : "Haydovchi"} buyurtma #${order.id} ni bekor qildi (mijoz chiqmadi)`, true);
  }
  if (status === "cancelled") {
    // Admin bekor qildi
    if (driver) {
      releaseDriver(io, driver);
      io.to(`driver_${driver.id}`).emit("order:cancelled", { id: order.id });
    }
    io.to("drivers").emit("order:closed", { id: order.id }); // efirdan olib tashlash
  }

  save(db);
  io.to("admins").emit("order:updated", order);
  if (driver) io.to("admins").emit("driver:status", { id: driver.id, status: driver.status });
  notifyQueues(io);
  res.json(order);
});

router.startOfferSweeper = startOfferSweeper;
module.exports = router;
