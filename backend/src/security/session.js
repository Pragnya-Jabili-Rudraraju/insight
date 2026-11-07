const session = require("express-session");
const { MongoStore } = require("connect-mongo");

function createSessionMiddleware(config) {
  if (config.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const store = MongoStore.create({
    mongoUrl: config.MONGODB_URI,
    collectionName: "sessions",
    ttl: 60 * 60 * 8,
    autoRemove: "native"
  });
  const middleware = session({
    name: config.NODE_ENV === "production" ? "__Host-insight.sid" : "insight.sid",
    secret: config.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 1000 * 60 * 60 * 8
    }
  });
  middleware.store = store;
  return middleware;
}

module.exports = { createSessionMiddleware };
