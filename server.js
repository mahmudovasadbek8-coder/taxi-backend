// server.js
// Entry point for the taxi dispatch backend.
// Run with:  npm install   then   npm start
// Server listens on http://localhost:4000 by default.

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const driversRouter = require("./routes/drivers");
const ordersRouter = require("./routes/orders");
const dispatchRouter = require("./routes/dispatch");
const zonesRouter = require("./routes/zones");
const { router: authRouter } = require("./routes/auth");
const placesRouter = require("./routes/places");
const statsRouter = require("./routes/stats");
const { verify } = require("./utils/auth");
const { load } = require("./db");

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.set("trust proxy", 1); // Railway kabi serverlarda to'g'ri IP uchun

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});
app.set("io", io);

app.use("/api/auth", authRouter);
app.use("/api/drivers", driversRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/dispatch", dispatchRouter);
app.use("/api/zones", zonesRouter);
app.use("/api/places", placesRouter);
app.use("/api/stats", statsRouter);

// Tariflar (haydovchi ilovasi jonli narxni hisoblashi uchun)
app.get("/api/tariff", (req, res) => {
  res.json(require("./utils/distance").TARIFF);
});

app.get("/", (req, res) => {
  res.send("Taxi backend is running. See README.md for API docs.");
});

// --- Socket.IO real-time layer ---
// Rooms used:
//   "admins"        -> every connected admin (Windows) app joins this
//   "drivers"       -> every connected driver app joins this (for broadcast/dispatch)
//   "driver_<id>"   -> a specific driver, used to target order offers to one driver
// Socket ulanishida ham token tekshiriladi
io.use((socket, next) => {
  const user = verify(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error("unauthorized"));
  socket.user = user;
  next();
});

io.on("connection", (socket) => {
  const u = socket.user;
  if (u.role === "admin") {
    socket.join("admins");
    console.log(`Admin ulandi (${socket.id})`);
  } else {
    socket.join("drivers");
    socket.join(`driver_${u.driverId}`);
    const d = load().drivers.find((x) => x.id === u.driverId);
    console.log(`Haydovchi ulandi: ${d ? d.name : u.driverId}`);
  }
  // Eski ilovalar bilan moslik uchun (xonalar endi tokendan belgilanadi)
  socket.on("admin:join", () => {});
  socket.on("driver:join", () => {});
});

// 15 soniyalik takliflarni kuzatib turish
ordersRouter.startOfferSweeper(io);

load(); // bazani oldindan yuklash (birinchi admin shu yerda yaratiladi)

server.listen(PORT, () => {
  console.log(`Taxi backend listening on http://localhost:${PORT}`);
});
