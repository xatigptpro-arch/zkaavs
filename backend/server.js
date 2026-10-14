import "dotenv/config";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const allowedOrigins = new Set([
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  process.env.FRONTEND_ORIGIN,
  ...(process.env.FRONTEND_ORIGINS ?? "").split(",").map(value => value.trim())
].filter(Boolean));

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
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

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/status", (_request, response) => {
  response.json({
    ok: true,
    service: "zkaavs-backend",
    environment: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString()
  });
});

app.use((error, _request, response, _next) => {
  const status = error.status ?? 500;
  response.status(status).json({ ok: false, error: status >= 500 ? "Internal server error" : error.message });
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
