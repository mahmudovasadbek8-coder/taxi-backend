// utils/pricing.js — narxlar: admin panelda o'zgartiriladigan sozlamalar, tariflar va qo'shimchalar
const DEFAULT_PRICING = {
  baseFare: 5000, // asosiy boshlash narxi ("Farqi yo'q")
  perKm: 2500, // 1 km narxi
  freeWaitSec: 60, // bepul kutish
  waitStepSec: 30, // undan keyin har N soniya uchun...
  waitStepPrice: 300, // ...shuncha so'm
};

// Birinchi ishga tushishdagi tariflar (keyin admin o'zgartiradi)
// mode: "any" — istalgan mashina | "class" — faqat shu turdagi mashina | "nearest" — eng yaqin istalgan mashina
const DEFAULT_TARIFFS = [
  { id: 1, key: "any", name: "Farqi yo'q", mode: "any", extra: 0, system: true },
  { id: 2, key: "komfort", name: "Komfort", mode: "class", extra: 1000 },
  { id: 3, key: "damas", name: "Damas", mode: "class", extra: 2000 },
  { id: 4, key: "dostavka", name: "Dostavka", mode: "nearest", extra: 0 },
];

function getPricing(db) {
  return { ...DEFAULT_PRICING, ...((db.settings && db.settings.pricing) || {}) };
}

function waitCost(waitSec, p) {
  const paid = Math.max(0, waitSec - p.freeWaitSec);
  return Math.ceil(paid / p.waitStepSec) * p.waitStepPrice;
}

function round100(n) {
  return Math.round(n / 100) * 100;
}

function tariffById(db, id) {
  return db.tariffs.find((t) => t.id === Number(id));
}
function tariffByKey(db, key) {
  return db.tariffs.find((t) => t.key === key);
}
// "Farqi yo'q" tarifi (tizimniki, o'chirilmaydi)
function defaultTariff(db) {
  return db.tariffs.find((t) => t.system) || db.tariffs[0];
}

// Buyurtma uchun narx "surati": keyin narxlar o'zgarsa ham, ketayotgan buyurtma shu bilan tugaydi
function priceSnapshot(db, tariff, extras = [], extraAmount = 0) {
  const p = getPricing(db);
  const extrasTotal = extras.reduce((s, e) => s + (Number(e.price) || 0), 0) + (Number(extraAmount) || 0);
  return {
    startFare: p.baseFare + (tariff ? Number(tariff.extra) || 0 : 0) + extrasTotal,
    extrasTotal,
    pricing: { perKm: p.perKm, freeWaitSec: p.freeWaitSec, waitStepSec: p.waitStepSec, waitStepPrice: p.waitStepPrice },
  };
}

// Safar tugaganda yakuniy narx
function finalFare(order, km, waitSec) {
  const p = order.pricing;
  return round100(order.startFare + km * p.perKm + waitCost(waitSec, p));
}

module.exports = {
  DEFAULT_PRICING,
  DEFAULT_TARIFFS,
  getPricing,
  waitCost,
  round100,
  tariffById,
  tariffByKey,
  defaultTariff,
  priceSnapshot,
  finalFare,
};
