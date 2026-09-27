// The session server, in one import. The transport lives in `http.ts` and the match in `room.ts`; this
// file is the boundary the outside world touches, and nothing else is exported on purpose — a second
// way in would be a second set of rules about who may connect and what a refusal means.

export { createSessionServer } from './http.ts';
export type { SessionServer } from './http.ts';
export { SessionRoom } from './room.ts';
export type { Admission } from './room.ts';
