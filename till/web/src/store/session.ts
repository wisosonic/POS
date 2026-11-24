import { create } from 'zustand';
import { ApiError, onAuthLost, post, refreshSession, setAccessToken, get } from '../lib/api';
import type { User } from '../lib/types';

type Status = 'loading' | 'anonymous' | 'authenticated';

type SessionState = {
  status: Status;
  user: User | null;
  /** Called once when the page loads: is there still a valid session (the refresh cookie)? */
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Hand the till to a cashier who types their PIN (the person already signed in is replaced). */
  switchByPin: (userId: number, pin: string) => Promise<void>;
};

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  user: null,

  async bootstrap() {
    if (await refreshSession()) {
      try {
        const me = await get<{ user: User }>('/me');
        return set({ status: 'authenticated', user: me.user });
      } catch {
        /* fall through */
      }
    }
    set({ status: 'anonymous', user: null });
  },

  async login(username, password) {
    const res = await post<{ accessToken: string; user: User }>('/auth/login', { username, password }, { noRefresh: true });
    setAccessToken(res.accessToken);
    set({ status: 'authenticated', user: res.user });
  },

  async switchByPin(userId, pin) {
    // noRefresh: a wrong PIN must count as one try, not be retried behind the scenes.
    const res = await post<{ accessToken: string; user: User }>('/auth/pin', { userId, pin }, { noRefresh: true });
    setAccessToken(res.accessToken);
    set({ status: 'authenticated', user: res.user });
  },

  async logout() {
    try {
      await post('/auth/logout');
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    setAccessToken(null);
    set({ status: 'anonymous', user: null });
  },
}));

// If the server says the session is over (refresh refused), go back to the login screen.
onAuthLost(() => {
  setAccessToken(null);
  useSession.setState({ status: 'anonymous', user: null });
});
