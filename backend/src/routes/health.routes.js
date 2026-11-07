const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "insight-api" });
});

router.get("/health/ready", (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", service: "insight-api" });
});

module.exports = { healthRouter: router };
