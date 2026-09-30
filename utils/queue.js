// utils/queue.js — stoyankalar (xaritadagi doiralar) va navbatlar
const { distanceKm } = require("./distance");

const LEAVE_GRACE_MS = 3 * 60 * 1000; // doiradan chiqsa — 3 daqiqa ichida qaytsa joyi saqlanadi

// Stoyankadagi navbat: bo'sh (available) haydovchilar, doiraga kirgan vaqti bo'yicha
function zoneQueue(db, zoneId) {
  return db.drivers
    .filter((d) => d.zoneId === zoneId && d.status === "available")
    .sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
}

function zonesWithQueues(db) {
  return db.zones.map((z) => ({
    ...z,
    queue: zoneQueue(db, z.id).map((d) => ({
      id: d.id,
      name: d.name,
      carClass: d.carClass,
      outside: !!d.outsideSince, // hozir doiradan tashqarida (3 daqiqa kutilmoqda)
    })),
  }));
}

// Nuqta qaysi stoyanka doirasi ichida (bir nechta bo'lsa — markazga eng yaqini)
function zoneAt(db, lat, lng) {
  let best = null;
  let bestKm = null;
  for (const z of db.zones) {
    if (z.lat == null || z.lng == null || !z.radius) continue;
    const km = distanceKm(lat, lng, z.lat, z.lng);
    if (km * 1000 <= z.radius && (bestKm === null || km < bestKm)) {
      best = z;
      bestKm = km;
    }
  }
  return best;
}

// GPS kelganda haydovchining navbatini yangilash. O'zgarish bo'lsa true qaytaradi.
function updateZoneMembership(db, driver) {
  if (driver.status === "offline" || driver.lat == null) return false;
  if (driver.status === "busy" && !driver.zoneId) return false; // buyurtmada — navbatga qo'shilmaydi
  const now = Date.now();
  const zone = zoneAt(db, driver.lat, driver.lng);
  const before = `${driver.zoneId}|${driver.queuedAt}|${driver.outsideSince}`;

  if (zone) {
    if (driver.zoneId === zone.id) {
      driver.outsideSince = null; // qaytib keldi — joyi saqlangan
    } else if (driver.status === "available") {
      driver.zoneId = zone.id; // yangi stoyankaga kirdi — navbat oxiriga
      driver.queuedAt = new Date(now).toISOString();
      driver.outsideSince = null;
    }
  } else if (driver.zoneId) {
    if (!driver.outsideSince) {
      driver.outsideSince = new Date(now).toISOString();
    } else if (now - new Date(driver.outsideSince).getTime() > LEAVE_GRACE_MS) {
      driver.zoneId = null; // 3 daqiqada qaytmadi — navbatdan chiqdi
      driver.queuedAt = null;
      driver.outsideSince = null;
    }
  }
  return before !== `${driver.zoneId}|${driver.queuedAt}|${driver.outsideSince}`;
}

function clearZone(driver) {
  driver.zoneId = null;
  driver.queuedAt = null;
  driver.outsideSince = null;
}

// Hammaga (admin + haydovchilar) "navbat o'zgardi" deb xabar berish
function notifyQueues(io) {
  io.emit("queues:changed");
}

module.exports = { zoneQueue, zonesWithQueues, zoneAt, updateZoneMembership, clearZone, notifyQueues, LEAVE_GRACE_MS };
