// utils/distance.js — masofa va narx hisoblash (TARIFLAR SHU YERDA)

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Ikki nuqta orasidagi masofa (km)
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== TARIFLAR (so'm) — faqat shu raqamlarni o'zgartirasiz =====
const TARIFF = {
  BASE_FARE: 5000, // mijoz "farqi yo'q" desa — shu narxdan boshlanadi
  CLASS_EXTRA: {
    damas: 2000, // Damas: 5000 + 2000 = 7000
    komfort: 1000, // Cobalt / Gentra: 5000 + 1000 = 6000
  },
  PER_KM: 2500, // har km uchun
  FREE_WAIT_SEC: 60, // bepul kutish: 1 daqiqa
  WAIT_STEP_SEC: 30, // undan keyin har 30 soniya uchun...
  WAIT_STEP_PRICE: 300, // ...300 so'm
};

// fareClass: null ("farqi yo'q") -> 5000, "komfort" -> 6000, "damas" -> 7000
function startFare(carClass) {
  return TARIFF.BASE_FARE + (TARIFF.CLASS_EXTRA[carClass] || 0);
}

// Kutish narxi: (mijozni kutish + safar paytidagi to'xtashlar) jami soniya
function waitCost(waitSec) {
  const paid = Math.max(0, waitSec - TARIFF.FREE_WAIT_SEC);
  return Math.ceil(paid / TARIFF.WAIT_STEP_SEC) * TARIFF.WAIT_STEP_PRICE;
}

function calcFare(distKm, carClass, waitSec = 0) {
  const fare = startFare(carClass) + distKm * TARIFF.PER_KM + waitCost(waitSec);
  return Math.round(fare / 100) * 100; // 100 so'mgacha yaxlitlash
}

module.exports = { distanceKm, calcFare, startFare, waitCost, TARIFF };
