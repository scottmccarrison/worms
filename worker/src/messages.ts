/**
 * Re-export of the shared wire protocol. Kept as a thin barrel so
 * imports inside worker/src/** can use a repo-local path and stay
 * independent of how the shared/ folder is wired into tsconfig.
 */
export * from "../../shared/protocol.js";
