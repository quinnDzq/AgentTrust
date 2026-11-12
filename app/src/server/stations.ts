import type { AgentKey, Station } from '../types.ts';

interface Point {
  readonly x: number;
  readonly y: number;
}

// Kept for the shared engine's queued-work timing and its regression tests.
const STATIONS: Record<Station, readonly [Point, ...Point[]]> = {
  desk: [{ x: 130, y: 318 }, { x: 360, y: 318 }, { x: 590, y: 318 }, { x: 820, y: 318 }],
  comms: [{ x: 1063, y: 290 }],
  podium: [{ x: 694, y: 524 }],
  booth: [{ x: 918, y: 482 }],
  inbox: [{ x: 1088, y: 542 }],
  meeting: [{ x: 421, y: 512 }, { x: 559, y: 512 }, { x: 421, y: 624 }, { x: 559, y: 624 }, { x: 490, y: 520 }],
  sleep: [{ x: 80, y: 466 }, { x: 80, y: 524 }, { x: 80, y: 582 }],
  beanbag: [{ x: 176, y: 558 }, { x: 240, y: 606 }],
  kopi: [{ x: 232, y: 482 }],
};

const CORRIDOR_Y = 380;
const WALK_SPEED = 220;

export function spot(station: Station, slot = 0): Point {
  const slots = STATIONS[station];
  const index = station === 'meeting' ? Math.min(slot, slots.length - 1) : slot;
  return slots[index] ?? slots[0];
}

function enclosure(station: Station): string {
  switch (station) {
    case 'sleep':
    case 'beanbag':
    case 'kopi':
      return 'lounge';
    default:
      return station;
  }
}

export function travelMs(from: Station, fromSlot: number, to: Station, toSlot: number): number {
  const start = spot(from, fromSlot);
  const end = spot(to, toSlot);
  if (start.x === end.x && start.y === end.y) return 0;

  const direct = enclosure(from) === enclosure(to) && from !== 'desk';
  const distance = direct
    ? Math.hypot(end.x - start.x, end.y - start.y)
    : Math.abs(start.y - CORRIDOR_Y) + Math.abs(end.x - start.x) + Math.abs(end.y - CORRIDOR_Y);
  return Math.round((distance / WALK_SPEED) * 1000);
}

export function homeStation(key: AgentKey, desk: number): { station: Station; slot: number } {
  if (key === 'bolt') return { station: 'comms', slot: 0 };
  if (key === 'raven') return { station: 'booth', slot: 0 };
  return { station: 'desk', slot: desk };
}

export const STANDUP_SLOT: Readonly<Record<Exclude<AgentKey, 'raven'>, number>> = {
  pip: 0,
  mochi: 1,
  shield: 2,
  tally: 3,
  bolt: 4,
};

export const GATE_SLOT: Readonly<Record<Extract<AgentKey, 'pip' | 'shield' | 'tally'>, number>> = {
  pip: 4,
  shield: 0,
  tally: 1,
};
