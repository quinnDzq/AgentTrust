/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { usd } from '../types.ts';
import { askThresholdFromEnv, defaultBudgetFromEnv, parseBudget } from './budget.ts';

describe('a buyer budget', () => {
  test('USD is the default currency, and a whole number of cents is kept', () => {
    expect(parseBudget(20)).toEqual({ ok: true, cents: usd(20) });
    expect(parseBudget(12.5, 'usd')).toEqual({ ok: true, cents: usd(12.5) });
    expect(parseBudget(0.01, ' USD ')).toEqual({ ok: true, cents: usd(0.01) });
  });

  test('zero, a negative, another currency, and an amount past the cap are refused', () => {
    expect(parseBudget(0).ok).toBe(false);
    expect(parseBudget(-5).ok).toBe(false);
    expect(parseBudget(10, 'EUR').ok).toBe(false);
    expect(parseBudget(10_001).ok).toBe(false);
    expect(parseBudget(Number.NaN).ok).toBe(false);
    expect(parseBudget(1.001).ok).toBe(false);
  });

  test('the environment default is USD 20, and a bad value falls back to it', () => {
    expect(defaultBudgetFromEnv({}).budget).toBe(usd(20));
    expect(defaultBudgetFromEnv({ AGENTTRUST_DEFAULT_BUDGET: '30' }).budget).toBe(usd(30));
    const bad = defaultBudgetFromEnv({ AGENTTRUST_DEFAULT_BUDGET: 'nope' });
    expect(bad.budget).toBe(usd(20));
    expect(bad.problem).toContain('AGENTTRUST_DEFAULT_BUDGET');
  });

  test('the ask threshold defaults to 50 percent, and a bad value falls back to it', () => {
    expect(askThresholdFromEnv({}).pct).toBe(50);
    expect(askThresholdFromEnv({ AGENTTRUST_ASK_THRESHOLD_PCT: '70' }).pct).toBe(70);
    expect(askThresholdFromEnv({ AGENTTRUST_ASK_THRESHOLD_PCT: '0' }).pct).toBe(0);
    expect(askThresholdFromEnv({ AGENTTRUST_ASK_THRESHOLD_PCT: '100' }).pct).toBe(100);
    const bad = askThresholdFromEnv({ AGENTTRUST_ASK_THRESHOLD_PCT: '50.5' });
    expect(bad.pct).toBe(50);
    expect(bad.problem).toContain('AGENTTRUST_ASK_THRESHOLD_PCT');
    expect(askThresholdFromEnv({ AGENTTRUST_ASK_THRESHOLD_PCT: '101' }).pct).toBe(50);
  });
});
