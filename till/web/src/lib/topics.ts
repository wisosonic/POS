// What changed on the branch server, learned from its ping (docs/14-connection-and-till-backend.md §3). The server keeps one number per
// topic that only goes up, plus an `epoch` that is new after every restart. A screen asks `GET /ping` every few seconds, compares the
// numbers with the ones it saw last and refreshes only the topics that moved. This replaces the live-update stream (`GET /events`).

export const TOPICS = ['catalog', 'stock', 'rate', 'settings', 'register', 'wallets', 'sync'] as const;
export type Topic = (typeof TOPICS)[number];

export type PingAnswer = { epoch: string; versions: Partial<Record<Topic, number>> };

/**
 * Which topics to refresh after this answer. The first answer is nothing new (the screen has just loaded everything itself). A new epoch
 * (the server restarted, or a backup was restored) or an answer after one that was missed means "everything": numbers may have gone
 * backwards, or changes may have passed unseen.
 */
export function changedTopics(prev: PingAnswer | null, next: PingAnswer, missed = false): Topic[] {
  if (!prev) return [];
  if (missed || prev.epoch !== next.epoch) return [...TOPICS];
  return TOPICS.filter((t) => (prev.versions[t] ?? 0) !== (next.versions[t] ?? 0));
}

export type WatchOptions = {
  /** Ask the server. `null` means no usable answer (it is away, or this is not an enrolled till). */
  ask: () => Promise<PingAnswer | null>;
  onChange: (topics: Topic[]) => void;
  everyMs?: number;
};

/** Ask every few seconds while the page is open, never two questions at once. Returns the function that stops it. */
export function watchTopics(opts: WatchOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: PingAnswer | null = null;
  let missed = false;
  const round = async () => {
    let answer: PingAnswer | null = null;
    try {
      answer = await opts.ask();
    } catch {
      answer = null;
    }
    if (stopped) return;
    if (!answer) {
      if (last) missed = true;
    } else {
      const topics = changedTopics(last, answer, missed);
      last = answer;
      missed = false;
      if (topics.length > 0) opts.onChange(topics);
    }
    timer = setTimeout(() => void round(), opts.everyMs ?? 3_000);
  };
  void round();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
