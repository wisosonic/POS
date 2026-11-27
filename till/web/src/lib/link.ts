import type { TillLink } from './tillServer';

// What the screens do with the heartbeat (docs/14). Kept apart from the screens so the rule is plain and testable:
// selling stops while the branch server does not answer (or the till program on this PC does not), and nothing else is touched.

export type SellingBlock = { cause: 'branch' | 'till'; reason: string | null; detail: string | null } | null;

/** The server's reason code, as a sentence the screen can translate (these exact texts are in `ar.ts`). */
export const REASON_TEXT: Record<string, string> = {
  TIMEOUT: 'Nothing answered in time: check that the branch server PC is on and on the network.',
  REFUSED: 'The PC answered but no branch server is running on it.',
  UNKNOWN_NAME: 'The branch server name is not known on this network.',
  UNREACHABLE: 'The branch server cannot be reached.',
  BAD_ANSWER: 'Something answered, but not a branch server.',
  HOST_NOT_ALLOWED: "The branch server does not accept this till's address (ask whoever set it up to add it to ALLOWED_HOSTS).",
};

/** Is selling stopped, and why? `null` means selling is allowed. `answer` is what `getTillLink` returned. */
export function sellingBlock(answer: TillLink | null | 'till-down'): SellingBlock {
  if (answer === 'till-down') return { cause: 'till', reason: 'TILL_DOWN', detail: null };
  if (answer === null || !answer.blocked) return null;
  return { cause: 'branch', reason: answer.reason, detail: answer.detail };
}
