/// <reference types="bun" />
/**
 * The wallet round's rules. The staged screens only replay what these return,
 * so the flow's promises are tested here: draws stay strictly under half the
 * starting amount, a wrong key stops at Layer 2 and leaves the budget alone,
 * and Layer 3 is the one that refuses an amount over what is left.
 */

import { describe, expect, test } from 'bun:test';
import {
  authorize,
  createTemplateKey,
  decisionReason,
  DEFAULT_WALLET_DRAFT,
  drawAmount,
  drawCeiling,
  formatAmount,
  layerLine,
  layerMark,
  layersVisited,
  parseAmount,
  paymentStatus,
  verifyRequest,
  withWallet,
  type TemplateRequest,
  type WalletRound,
} from './wallet-template';

const round = (remaining = 2_000): WalletRound => ({
  wallet: 'paypal',
  currency: 'USD',
  startingAmount: 2_000,
  remaining,
});

const request = (amount: number, wrongKey = false): TemplateRequest => ({ reference: 'DEMO-001', amount, wrongKey });

describe('drawing a request', () => {
  test('a 20.00 USD round draws at most 9.99', () => {
    expect(drawCeiling(2_000)).toBe(999);
  });

  test('the ceiling is strictly below half, for odd and even budgets', () => {
    for (const start of [3, 4, 5, 100, 101, 2_000, 2_001]) {
      const ceiling = drawCeiling(start);
      expect(ceiling * 2).toBeLessThan(start);
      expect((ceiling + 1) * 2).toBeGreaterThanOrEqual(start);
    }
  });

  test('every draw is positive and within the ceiling, and differs from the last one', () => {
    let previous: number | undefined;
    for (let i = 0; i < 500; i++) {
      const amount = drawAmount(999, previous);
      expect(amount).toBeGreaterThanOrEqual(1);
      expect(amount).toBeLessThanOrEqual(999);
      expect(amount).not.toBe(previous);
      previous = amount;
    }
  });

  test('a budget too small to halve has nothing to draw', () => {
    expect(drawCeiling(2)).toBe(0);
    expect(() => drawAmount(0)).toThrow(RangeError);
  });
});

describe('reading the starting amount', () => {
  test('in the currency’s smallest unit, without floating point', () => {
    expect(parseAmount('20.00', 'USD')).toBe(2_000);
    expect(parseAmount('20', 'USD')).toBe(2_000);
    expect(parseAmount('0.1', 'USD')).toBe(10);
    expect(parseAmount('1.5', 'USDC')).toBe(1_500_000);
  });

  test('refuses what the currency cannot hold', () => {
    expect(parseAmount('20.001', 'USD')).toBeNull();
    expect(parseAmount('1.0000001', 'USDC')).toBeNull();
    expect(parseAmount('-5', 'USD')).toBeNull();
    expect(parseAmount('abc', 'USD')).toBeNull();
    expect(parseAmount('1000000.01', 'USD')).toBeNull();
  });

  test('formats back with at least two decimals', () => {
    expect(formatAmount(999, 'USD')).toBe('9.99');
    expect(formatAmount(1_500_000, 'USDC')).toBe('1.50');
    expect(formatAmount(1_234_567, 'USDT')).toBe('1.234567');
  });
});

describe('changing the wallet keeps the draft', () => {
  test('the amount stays as typed; the currency stays when the wallet has it', () => {
    const typed = { ...DEFAULT_WALLET_DRAFT, amount: '35.50' };
    expect(withWallet(typed, 'electronic')).toEqual({ wallet: 'electronic', currency: 'USD', amount: '35.50' });
    expect(withWallet(typed, 'blockchain')).toEqual({ wallet: 'blockchain', currency: 'USDC', amount: '35.50' });
  });
});

describe('Layer 3 compares the amount with what is left', () => {
  test('an amount that fits is taken off the budget', () => {
    expect(authorize(2_000, 990)).toEqual({ fits: true, remainingBefore: 2_000, remainingAfter: 1_010, overBy: 0 });
    expect(authorize(990, 990).fits).toBe(true);
  });

  test('an amount over what is left is refused and the budget stays', () => {
    expect(authorize(167, 990)).toEqual({ fits: false, remainingBefore: 167, remainingAfter: 167, overBy: 823 });
  });
});

describe('one request through the three layers', () => {
  test('the registered key and a fitting amount: approved, and only simulated', async () => {
    const keys = await createTemplateKey();
    const outcome = await verifyRequest(round(), request(420), keys);

    expect(outcome.key.matches).toBe(true);
    expect(outcome.key.presented).toBe(outcome.key.registered);
    expect(outcome.approved).toBe(true);
    expect(outcome.stoppedAt).toBeNull();
    expect(outcome.authorization?.remainingAfter).toBe(1_580);
    expect(layersVisited(outcome)).toEqual([1, 2, 3]);
    expect([1, 2, 3].map((layer) => layerMark(outcome, layer as 1 | 2 | 3))).toEqual(['noted', 'pass', 'pass']);
    expect(paymentStatus(outcome)).toBe('Simulated approval. No money moved.');
  });

  test('a wrong key stops at Layer 2: Layer 3 is skipped and the budget is untouched', async () => {
    const keys = await createTemplateKey();
    const outcome = await verifyRequest(round(), request(420, true), keys);

    expect(outcome.key.matches).toBe(false);
    expect(outcome.key.presented).not.toBe(outcome.key.registered);
    expect(outcome.authorization).toBeNull();
    expect(outcome.approved).toBe(false);
    expect(outcome.stoppedAt).toBe(2);
    expect(layersVisited(outcome)).toEqual([1, 2]);
    expect(layerMark(outcome, 3)).toBe('skipped');
    expect(layerLine(outcome, 3, request(420, true), 'USD')).toBe('Skipped. The request stopped at the key check.');
    expect(paymentStatus(outcome)).toBe('Stopped before the wallet. No charge.');
  });

  test('the registered key but too little left: Layer 3 refuses, with the two amounts', async () => {
    const keys = await createTemplateKey();
    const outcome = await verifyRequest(round(167), request(990), keys);

    expect(outcome.key.matches).toBe(true);
    expect(outcome.approved).toBe(false);
    expect(outcome.stoppedAt).toBe(3);
    expect(layerMark(outcome, 3)).toBe('fail');
    expect(decisionReason(outcome, request(990), 'USD')).toBe('9.90 USD is more than the 1.67 USD left in this round.');
  });

  test('Layer 1 is advisory: it is noted, and never changes the outcome', async () => {
    const keys = await createTemplateKey();
    const outcome = await verifyRequest(round(), request(420), keys);
    expect(layerMark(outcome, 1)).toBe('noted');
    expect(layerLine(outcome, 1, request(420), 'USD')).toBe('Reads like a Claude profile.');
  });
});
