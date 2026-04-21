import { Client } from "colyseus.js";

/**
 * Builds the Colyseus WebSocket URL for the current environment.
 *
 * - Dev (Vite :5173): server runs on the same host but port :2567.
 * - Prod: server is expected behind the same origin (reverse-proxied).
 *
 * Respects the page protocol (ws:// vs wss://) so secure origins keep TLS.
 */
function serverUrl(): string {
  const { protocol, hostname, port } = window.location;
  const wsProto = protocol === "https:" ? "wss" : "ws";
  const wsHost = import.meta.env.DEV ? `${hostname}:2567` : `${hostname}${port ? `:${port}` : ""}`;
  return `${wsProto}://${wsHost}`;
}

/**
 * Creates a Colyseus Client pointed at the current origin's multiplayer server.
 * Callers typically create one Client per page load and reuse it for all rooms.
 */
export function createNetClient(): Client {
  return new Client(serverUrl());
}
