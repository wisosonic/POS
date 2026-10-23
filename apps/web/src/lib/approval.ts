import { ApiError, post, refreshSession } from './api';

// Asking the server for a manager's approval (POST /auth/approve). The manager's name and password go in once, the answer is
// a token that works once, for the signed-in cashier only (docs/08-security-review.md). Shared by every screen that needs one.

export type ApprovalRequest =
  | { scope: 'discount'; pct: number }
  | { scope: 'return'; saleId: number; maxLbp: number }
  | { scope: 'void'; saleId: number }
  | { scope: 'price'; productId: number; priceLbp: number };

type Answer = { approvalToken: string; approvedBy: { name: string } };

export async function requestApproval(who: { username: string; password: string }, what: ApprovalRequest): Promise<Answer> {
  const body = { ...what, username: who.username, password: who.password };
  // noRefresh: a refused password must count as ONE failed try, not be retried behind the scenes after a session refresh.
  const attempt = () => post<Answer>('/auth/approve', body, { noRefresh: true });
  try {
    return await attempt();
  } catch (err) {
    // The cashier's own sign-in may simply have expired: renew it and try once more. A refused manager password says so.
    if (err instanceof ApiError && err.status === 401 && err.message === 'Authentication required' && (await refreshSession()))
      return attempt();
    throw err;
  }
}
