import { type Client, Room } from "@colyseus/core";

/**
 * One GameRoom instance per active game.
 *
 * Scaffold only. Full implementation lands in Epic 8 (lobby + room codes),
 * Epic 9 (authoritative state + schema), and Epic 10 (reconnection).
 * See docs/decisions/001-framework-pivot.md for context.
 */
export class GameRoom extends Room {
  maxClients = 8;

  onCreate(): void {
    console.log("GameRoom created", this.roomId);
  }

  onJoin(client: Client): void {
    console.log(client.sessionId, "joined", this.roomId);
  }

  onLeave(client: Client): void {
    console.log(client.sessionId, "left", this.roomId);
  }

  onDispose(): void {
    console.log("GameRoom disposed", this.roomId);
  }
}
