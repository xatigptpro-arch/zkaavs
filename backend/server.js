import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { isIP } from "node:net";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const allowedOrigins = new Set([
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:8080", "http://127.0.0.1:8080"]),
  process.env.FRONTEND_ORIGIN,
  ...(process.env.FRONTEND_ORIGINS ?? "").split(",").map(value => value.trim())
].filter(Boolean));

app.disable("x-powered-by");
app.disable("etag");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use((_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use((request, response, next) => {
  if (process.env.NODE_ENV === "production" && request.get("X-Forwarded-Proto") === "http") {
    response.redirect(308, `https://api.zkaavs.app${request.originalUrl}`);
    return;
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    const error = new Error("Origin not allowed");
    error.status = 403;
    callback(error);
  }
}));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Cloudflare sets this header; only the dedicated tunnel can reach this API.
  keyGenerator(request) {
    const edgeIP = request.get("CF-Connecting-IP");
    return ipKeyGenerator(edgeIP && isIP(edgeIP) ? edgeIP : request.ip);
  },
  message: { ok: false, error: "Too many requests" }
}));
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/status", (_request, response) => {
  response.json({ ok: true });
});

app.use((_request, response) => {
  response.status(404).json({ ok: false, error: "Not found" });
});

app.use((error, _request, response, _next) => {
  const status = error.status ?? 500;
  const message = status >= 500 ? "Internal server error"
    : status === 403 ? "Origin not allowed"
    : status === 413 ? "Request too large" : "Invalid request";
  response.status(status).json({ ok: false, error: message });
});

const server = app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
