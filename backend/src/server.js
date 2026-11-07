const { loadConfig } = require("./config/env");
const { createApp } = require("./app");
const mongoose = require("mongoose");
const { createSessionMiddleware } = require("./security/session");
const { purgeExpiredData } = require("./retention/retention.service");

async function start() {
  const config = loadConfig();
  if (config.SESSION_SECRET.length < 32) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await purgeExpiredData(config);
  const sessionMiddleware = createSessionMiddleware(config);
  const app = createApp(config, { sessionMiddleware });
  const server = app.listen(config.PORT, () => {
    console.warn(`Insight API listening on port ${config.PORT} (${config.NODE_ENV})`);
  });
  const retentionInterval = setInterval(() => {
    purgeExpiredData(config).catch((error) => console.error("retention_purge_failed", { name: error.name }));
  }, 24 * 60 * 60 * 1000);
  retentionInterval.unref();

  const shutdown = () => server.close(async () => {
    clearInterval(retentionInterval);
    await mongoose.disconnect();
    await sessionMiddleware.store.close();
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("startup_failed", { name: error.name });
  process.exitCode = 1;
});
