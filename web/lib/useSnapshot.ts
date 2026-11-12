'use client';

import type { VerificationSnapshot } from '@app/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** How often to ask for the world. A capture lands a second or two after the click. */
const POLL_MS = 1_000;

/**
 * The server's snapshot, polled. `seq` moves on every change, so an unchanged
 * world costs a comparison and no render. `refresh` asks again at once, for
 * right after a click.
 */
export function useSnapshot(): {
  readonly snap: VerificationSnapshot | null;
  readonly offline: boolean;
  readonly refresh: () => void;
} {
  const [snap, setSnap] = useState<VerificationSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const seq = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const poll = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    try {
      const next = await api.state();
      if (!alive.current) return;
      setOffline(false);
      if (next.seq !== seq.current) {
        seq.current = next.seq;
        setSnap(next);
      }
    } catch {
      if (alive.current) setOffline(true);
    }
    if (alive.current) timer.current = setTimeout(() => void poll(), POLL_MS);
  }, []);

  useEffect(() => {
    alive.current = true;
    void poll();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  return { snap, offline, refresh: () => void poll() };
}
