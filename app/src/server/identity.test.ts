/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { identityLogLine, identityModeFromEnv } from './identity.ts';
import { publicBaseUrl } from './paypal.ts';

describe('AGENTTRUST_IDENTITY_MODE', () => {
  test('unset and local both mean the local key, even when a registration is configured', () => {
    expect(identityModeFromEnv({}, true)).toEqual({ mode: 'local', problem: null });
    expect(identityModeFromEnv({ AGENTTRUST_IDENTITY_MODE: '  Local  ' }, true)).toEqual({ mode: 'local', problem: null });
  });

  test('erc8004 keeps the chain check, including when nothing is configured yet', () => {
    expect(identityModeFromEnv({ AGENTTRUST_IDENTITY_MODE: 'erc8004' }, false)).toEqual({ mode: 'erc8004', problem: null });
  });

  test('auto follows whether a registration is configured', () => {
    expect(identityModeFromEnv({ AGENTTRUST_IDENTITY_MODE: 'auto' }, true).mode).toBe('erc8004');
    expect(identityModeFromEnv({ AGENTTRUST_IDENTITY_MODE: 'AUTO' }, false).mode).toBe('local');
  });

  test('an unknown value is reported and does not pretend to be a chain check', () => {
    expect(identityModeFromEnv({ AGENTTRUST_IDENTITY_MODE: 'testnet' }, true)).toEqual({
      mode: 'local',
      problem: 'AGENTTRUST_IDENTITY_MODE "testnet" is not local, erc8004 or auto. Using local.',
    });
  });

  test('the startup line for local mode does not say a registration is missing', () => {
    const local = identityLogLine({ mode: 'local', problem: null }, { config: null, problem: null });
    expect(local).toBe('local key pair (Ed25519)');
    expect(local).not.toContain('ERC-8004');

    const chain = {
      config: { agentId: '42', registry: '0xabc', network: 'Base Sepolia' },
      problem: null,
    };
    expect(identityLogLine({ mode: 'erc8004', problem: null }, chain)).toBe(
      'ERC-8004 agent 42 in 0xabc on Base Sepolia',
    );
    expect(identityLogLine({ mode: 'erc8004', problem: null }, { config: null, problem: null })).toBe(
      'ERC-8004 no registration configured',
    );
  });
});

describe('PUBLIC_BASE_URL', () => {
  test('defaults to this server and drops trailing slashes', () => {
    expect(publicBaseUrl({}, 8787)).toBe('http://localhost:8787');
    expect(publicBaseUrl({ PUBLIC_BASE_URL: '  https://tunnel.example/  ' }, 8787)).toBe('https://tunnel.example');
    expect(publicBaseUrl({ PUBLIC_BASE_URL: 'https://tunnel.example///' }, 8787)).toBe('https://tunnel.example');
  });
});
