import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { GameRoom } from "./rooms/GameRoom.js";

const port = Number(process.env.PORT ?? 2567);

// Express app served alongside the Colyseus WebSocket transport.
// Currently exposes /health so the Fly / EC2 / nginx layer can check
// that the process is alive. Epic 13 will extend this with auth +
// admin endpoints as needed.
const app = express();

// Dev CORS: the Vite dev server runs on :5173 and the /health endpoint
// is occasionally hit from it. Production serves both client and
// server from the same origin (reverse proxy) so CORS is a no-op
// there.
app.use(
  cors({
    origin: ["http://localhost:5173"],
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// filterBy(["code"]) tells Colyseus to route client-side
// `joinOrCreate("game", { code })` to the room whose metadata
// `code` matches. See GameRoom.onCreate where we setMetadata({ code }).
gameServer.define("game", GameRoom).filterBy(["code"]);

httpServer.listen(port, () => {
  console.log(`worms Colyseus server listening on :${port}`);
});
