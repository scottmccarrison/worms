/**
 * Client-side re-export of the shared protocol.
 *
 * Prefer importing from `./types` for legacy aliases like `GameStartedMessage`;
 * this module is the thin pass-through used by the new WsClient + any code
 * that wants the raw discriminated unions.
 */
export * from "../../shared/protocol";
