import "dotenv/config";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

const allowedOrigins = new Set([
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  process.env.FRONTEND_ORIGIN
].filter(Boolean));

app.use(express.json());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin not allowed by CORS: ${origin}`));
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

app.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${port}`);
});
