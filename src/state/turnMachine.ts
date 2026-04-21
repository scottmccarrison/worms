import { assign, setup } from "xstate";
import { tuning } from "../tuning";

export type TurnContext = {
  teamOrder: string[]; // ids in play order, e.g. ["red", "blue"]
  currentTeamIdx: number; // index into teamOrder
  turnElapsedMs: number; // how long current turn has run
  turnEndingElapsedMs: number; // total time in turnEnding state this cycle
  winnerId: string | null; // set on GAME_OVER; null = tie
};

export type TurnEvent =
  | { type: "START_GAME"; teamOrder: string[] }
  | { type: "TICK"; dtMs: number }
  | { type: "END_TURN" }
  | { type: "ACTIVE_WORM_DIED" }
  | { type: "SETTLED" }
  | { type: "GAME_OVER"; winnerId: string | null };

export const turnMachine = setup({
  types: {
    context: {} as TurnContext,
    events: {} as TurnEvent,
  },
  guards: {
    turnTimerExpired: ({ context, event }) =>
      event.type === "TICK" && context.turnElapsedMs + event.dtMs >= tuning.turn.durationMs,
    maxSettleReached: ({ context, event }) =>
      event.type === "TICK" && context.turnEndingElapsedMs + event.dtMs >= tuning.turn.maxSettleMs,
  },
  actions: {
    advanceTurnTimer: assign({
      turnElapsedMs: ({ context, event }) =>
        event.type === "TICK" ? context.turnElapsedMs + event.dtMs : context.turnElapsedMs,
    }),
    advanceTurnEnding: assign({
      turnEndingElapsedMs: ({ context, event }) =>
        event.type === "TICK"
          ? context.turnEndingElapsedMs + event.dtMs
          : context.turnEndingElapsedMs,
    }),
    resetTurnState: assign({
      turnElapsedMs: 0,
      turnEndingElapsedMs: 0,
    }),
    cycleTeam: assign({
      currentTeamIdx: ({ context }) => (context.currentTeamIdx + 1) % context.teamOrder.length,
    }),
    setWinner: assign({
      winnerId: ({ event }) => (event.type === "GAME_OVER" ? event.winnerId : null),
    }),
  },
}).createMachine({
  id: "turns",
  initial: "idle",
  context: {
    teamOrder: [],
    currentTeamIdx: 0,
    turnElapsedMs: 0,
    turnEndingElapsedMs: 0,
    winnerId: null,
  },
  states: {
    idle: {
      on: {
        START_GAME: {
          target: "turnActive",
          actions: [
            assign({
              teamOrder: ({ event }) => event.teamOrder,
              currentTeamIdx: 0,
              turnElapsedMs: 0,
              turnEndingElapsedMs: 0,
              winnerId: null,
            }),
          ],
        },
      },
    },
    turnActive: {
      entry: ["resetTurnState"],
      on: {
        TICK: [
          { guard: "turnTimerExpired", target: "turnEnding" },
          { actions: ["advanceTurnTimer"] },
        ],
        END_TURN: { target: "turnEnding" },
        ACTIVE_WORM_DIED: { target: "turnEnding" },
        GAME_OVER: { target: "gameOver", actions: ["setWinner"] },
      },
    },
    turnEnding: {
      on: {
        TICK: [
          {
            guard: "maxSettleReached",
            target: "turnActive",
            actions: ["cycleTeam"],
          },
          { actions: ["advanceTurnEnding"] },
        ],
        SETTLED: {
          target: "turnActive",
          actions: ["cycleTeam"],
        },
        GAME_OVER: { target: "gameOver", actions: ["setWinner"] },
      },
    },
    gameOver: {
      type: "final",
    },
  },
});
