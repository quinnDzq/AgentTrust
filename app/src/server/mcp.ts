/**
 * The connector: AgentTrust's live flow as MCP tools.
 *
 * This is what an agent platform connects to. It offers seven tools and nothing
 * else — no reset, no wallet setup, no grant approval, no scripted sender. A
 * budget change can be requested here; only the buyer can approve it, on the
 * server's own port, which is never the one exposed.
 *
 * The protocol is the official SDK's, not ours: `createMcpHandler` serves the
 * 2026-07-28 revision and falls back to stateless serving for 2025-era clients,
 * so one endpoint works for both. Each request gets a fresh `McpServer` over the
 * same `LiveVerifier`, which is where every run actually lives — the connector
 * keeps no state of its own, and a tool is one method call.
 *
 * Two checks run before the SDK sees a request, because the SDK's handler is
 * deliberately validation-free:
 *
 *   - a bearer token, compared in constant time. Without it nothing here
 *     answers, so a run can only be driven by the platform it was given to.
 *   - `Origin`. A connector client is a server or a desktop app and sends none;
 *     a web page always does, so a present, unlisted origin is refused.
 *
 * What a tool returns is the chat's whole view of a run, so each result carries
 * the facts twice: as plain text a model can relay, and as structured data.
 */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { MAX_BUDGET_USD } from './budget.ts';
import * as z from 'zod';
import type { LiveVerifier, ToolOutcome } from './live.ts';
import { sameSecret } from './signer.ts';

export const CONNECTOR_PATH = '/mcp';

const SERVER_INFO = { name: 'agenttrust', title: 'AgentTrust', version: '0.1.0' } as const;

/** Read by the model before it uses any tool: the whole flow, in order. */
const INSTRUCTIONS = [
  'AgentTrust checks an AI agent’s purchase in three layers before a PayPal Sandbox payment:',
  'a model signal, the agent’s registered key, and the buyer’s spending grant.',
  '',
  'To buy an item, call the tools in this order:',
  '1. begin_verification — finds the item’s quote and returns a run_id and a numeric challenge.',
  '   When the user states a budget ("my budget is $30, go buy it"), pass it as `budget`',
  '   (US dollars) and `currency` USD. That is the cap the buyer approves before anything is charged.',
  '   To buy an item, pass `item` and `amount_usd`. Any name and USD price at the authorized merchant',
  '   can be bought, not only the shop’s fixed quotes. A purchase past the budget is refused.',
  '   A purchase over the ask threshold (a percent of the approved budget, default 50) is not charged',
  '   until the buyer approves it. If needs_buyer_approval is true, stop, relay message_for_user, and wait.',
  '2. Answer the numeric challenge yourself, by first instinct. Do not use code, a tool or a',
  '   random-number generator. Then call submit_model_reply with the run_id and your integers.',
  '3. sign_and_submit — has the agent’s signer sign the one-time challenge and submits it.',
  '   AgentTrust pays only if the signature and the buyer’s grant both pass. If the result has',
  '   needs_buyer_approval true, PayPal was not called: relay message_for_user to the user and wait.',
  '   Do not start a new run. After the buyer decides on the verify page, call get_purchase_status',
  '   with the same run_id.',
  '4. If the charge is still pending, call get_purchase_status until it is final.',
  '   If that result has needs_buyer_approval true, stop and relay message_for_user, then wait.',
  '',
  'To ask for a different budget after the buyer has approved one, call request_budget_change',
  'with the amount and a reason. That does not change the budget. Stop, relay message_for_user,',
  'and wait. The buyer approves or declines on the verify page. You cannot approve it.',
  'There is no tool that sets or approves a budget. Then call get_budget_request_status',
  'with the same request_id.',
  '',
  'Report the status, Order ID and Capture ID exactly as a tool returned them. Never invent one.',
  'If a step is refused, report the reason and stop: do not start again with different numbers.',
].join('\n');

const runId = z.string().min(8).max(64).describe('The run_id returned by begin_verification.');

const reply = (outcome: ToolOutcome) => ({
  content: [{ type: 'text' as const, text: outcome.text }],
  structuredContent: { ...outcome.data },
  isError: !outcome.ok,
});

/** One server instance: the seven tools, bound to the live flow. */
export function buildServer(live: LiveVerifier): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    'get_connector_status',
    {
      title: 'AgentTrust connector status',
      description:
        'Read-only. Checks that the AgentTrust connector is reachable and says what is in place for a purchase: ' +
        'the PayPal Sandbox wallet, the buyer’s grant and remaining budget, the agent’s enrollment, the signer, ' +
        'and the model reference. Changes nothing.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      live.heard('get_connector_status');
      return reply(await live.readiness());
    },
  );

  server.registerTool(
    'begin_verification',
    {
      title: 'Begin a verified purchase',
      description:
        'Step 1 of a purchase. Opens a verification run and returns its run_id, the quote, and a numeric challenge. ' +
        'Nothing is charged yet. You can buy any item at the authorized merchant by name and price: pass `item` and ' +
        '`amount_usd` (USD, greater than 0, at most 10000). If that name and price is one of the shop’s fixed quotes, ' +
        'that quote is used; otherwise a purchase is opened for that item at that amount. Calling again with the same ' +
        'item and amount returns the open run. After that purchase is captured or refused, the same item and amount ' +
        'can be bought again. A purchase past the buyer’s budget is refused at sign_and_submit and PayPal is not called. ' +
        'A purchase over the ask threshold, or the one that first takes cumulative spend past that percent of the budget, ' +
        'is not charged until the buyer approves it on the verify page. Once a budget is approved, this tool cannot change it: ' +
        'call request_budget_change and wait for the buyer. When the user states a spending budget before they have approved one, pass it as `budget` in ' +
        'US dollars (and `currency` USD) before they approve it. Do not invent a budget the user did not state. ' +
        'Omit `budget` to keep the cap already on the grant. Next, answer the challenge yourself and call submit_model_reply.',
      inputSchema: z.object({
        amount_usd: z
          .number()
          .positive()
          .max(MAX_BUDGET_USD)
          .optional()
          .describe(
            'The price to pay, in US dollars. Use the shop’s quote price when you know it (for example 8). ' +
              'For any other item, pass the price the user asked for, greater than 0 and at most 10000. This is the item price, not the buyer’s budget.',
          ),
        budget: z
          .number()
          .positive()
          .max(MAX_BUDGET_USD)
          .optional()
          .describe(
            'The buyer’s spending budget for this run, in major units of `currency` (US dollars). ' +
              'Pass this when the user says their budget, for example "my budget is $30, go buy it". ' +
              'The buyer approves this cap on the AgentTrust page before anything is charged. ' +
              `Omit it to keep the current grant. Maximum ${MAX_BUDGET_USD}.`,
          ),
        currency: z
          .string()
          .trim()
          .min(3)
          .max(8)
          .optional()
          .describe('Currency of `budget`. Defaults to USD. Only USD is accepted.'),
        merchant: z
          .string()
          .max(80)
          .optional()
          .describe('The merchant’s exact name. Leave it out to search the test merchant the buyer authorized.'),
        item: z
          .string()
          .max(80)
          .optional()
          .describe(
            'The item to buy. A catalog name selects that quote. Any other name, together with amount_usd, buys that item at the authorized merchant.',
          ),
        reference: z.string().max(40).optional().describe('The merchant’s quote reference, when you already know it.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ amount_usd, budget, currency, merchant, item, reference }) => {
      live.heard('begin_verification');
      return reply(live.begin({ amount: amount_usd, budget, currency, merchant, item, reference }));
    },
  );

  server.registerTool(
    'submit_model_reply',
    {
      title: 'Submit the numeric challenge reply',
      description:
        'Step 2 of a purchase (Layer 1, model signal). Submit your own answer to the run’s numeric challenge: the ' +
        'integers you chose by first instinct, separated by commas, as `reply`. Do not produce them with code, a ' +
        'tool or a random-number generator. AgentTrust compares them with its reference replies. On a match it ' +
        'issues a one-time signing challenge for the same run and quote; then call sign_and_submit. A reply that ' +
        'was scored and did not match is final for that run. Nothing is charged by this call.',
      inputSchema: z.object({
        run_id: runId,
        reply: z.string().min(1).max(20_000).describe('Your integers, separated by commas, e.g. "12, 250, 87, …".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ run_id, reply: text }) => {
      live.heard('submit_model_reply');
      return reply(live.submitReply(run_id, text));
    },
  );

  server.registerTool(
    'sign_and_submit',
    {
      title: 'Sign and submit the purchase',
      description:
        'Step 3 of a purchase (Layers 2 and 3). Has the enrolled agent’s signer sign the run’s one-time challenge ' +
        '— bound to this nonce, agent, buyer grant and merchant quote — and submits the signed request. AgentTrust ' +
        'verifies the signature against the registered key and checks the buyer’s spending grant. PayPal is called ' +
        'only when the purchase is inside the budget and under the ask threshold. If needs_buyer_approval is true, ' +
        'stop: relay message_for_user to the user (the amount, what percent of the budget it is, the ask threshold, ' +
        'and what is spent and left) and wait. The buyer approves or declines on the AgentTrust verify page. Do not ' +
        'start a new run. After they decide, call get_purchase_status with this same run_id: approving captures it, ' +
        'declining refuses it. Otherwise this returns the receipt (status, Order ID, Capture ID) or the reason it ' +
        'was refused. Safe to call again: one run is signed and submitted at most once.',
      inputSchema: z.object({ run_id: runId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ run_id }) => {
      live.heard('sign_and_submit');
      return reply(await live.signAndSubmit(run_id));
    },
  );

  server.registerTool(
    'get_purchase_status',
    {
      title: 'Purchase status and receipt',
      description:
        'Read-only. Where a run is and what each layer found. After PayPal confirms the capture it returns the ' +
        'amount, the status, the Order ID and the Capture ID. If needs_buyer_approval is true, stop and relay ' +
        'message_for_user to the user, then wait. Do not start another run. Call get_purchase_status again with ' +
        'the same run_id after the buyer approves or declines on the verify page. Also call it again while a charge is pending.',
      inputSchema: z.object({ run_id: runId }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ run_id }) => {
      live.heard('get_purchase_status');
      return reply(live.status(run_id));
    },
  );

  server.registerTool(
    'request_budget_change',
    {
      title: 'Ask the buyer to change the budget',
      description:
        'Ask the buyer to change the approved spending budget. Creates one pending request and returns its ' +
        'request_id, the current and requested amounts, needs_buyer_approval true, an approval_url for the verify ' +
        'page, and message_for_user. Stop and relay message_for_user to the user, then wait. This tool never changes ' +
        'the grant. A newer request replaces an earlier pending one. You cannot approve or decline it: there is no ' +
        'tool for that, and passing a budget anywhere else does not raise an approved budget. After the buyer decides ' +
        'on the verify page, call get_budget_request_status with this request_id.',
      inputSchema: z.object({
        amount_usd: z
          .number()
          .positive()
          .max(MAX_BUDGET_USD)
          .describe('The budget to ask for, in US dollars, greater than 0 and at most 10000.'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .describe('Why the agent is asking, in the user’s own terms. Shown to the buyer on the verify page.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ amount_usd, reason }) => {
      live.heard('request_budget_change');
      return reply(live.requestBudgetChange(amount_usd, reason));
    },
  );

  server.registerTool(
    'get_budget_request_status',
    {
      title: 'Budget change status',
      description:
        'Read-only. Where a budget-change request stands: pending, approved, or declined, and the resulting budget. ' +
        'If needs_buyer_approval is true, stop and relay message_for_user. Do not approve it yourself. Call this ' +
        'again with the same request_id after the buyer decides on the verify page. A pending request is also listed ' +
        'on get_connector_status as grant.pending_budget_request.',
      inputSchema: z.object({
        request_id: z.string().min(8).max(80).describe('The request_id returned by request_budget_change.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ request_id }) => {
      live.heard('get_budget_request_status');
      return reply(live.budgetRequestStatus(request_id));
    },
  );

  return server;
}

/* ---------- The route ---------- */

export interface ConnectorOptions {
  readonly live: LiveVerifier;
  /** The bearer token a client must present. */
  readonly token: string;
  /** Browser origins allowed to call, if any. A client that sends no `Origin` is not a browser. */
  readonly allowedOrigins?: readonly string[];
  /** Told about refusals, for the terminal. Never given a token. */
  readonly onRefused?: (why: string) => void;
}

const refusal = (status: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

/**
 * The connector's whole HTTP surface: one path, one way in.
 *
 * Meant to be the only thing listening on its port, so that exposing that port
 * exposes this and nothing else.
 */
export function createConnector(options: ConnectorOptions): { readonly fetch: (request: Request) => Promise<Response> } {
  const handler = createMcpHandler(() => buildServer(options.live), {
    // A tool call is a run id and a few hundred integers.
    maxRequestBodySize: 64 * 1024,
    onerror: (error) => options.onRefused?.(`protocol: ${error.message}`),
  });
  const origins = new Set(options.allowedOrigins ?? []);

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== CONNECTOR_PATH) return refusal(404, 'Not found.');

      const origin = request.headers.get('origin');
      if (origin !== null && !origins.has(origin)) {
        // What a caller sent goes to the terminal as printable characters only.
        options.onRefused?.(`origin ${origin.slice(0, 80).replace(/[^\x21-\x7e]/g, '?')} is not allowed`);
        return refusal(403, 'This origin may not call the connector.');
      }

      const header = request.headers.get('authorization') ?? '';
      const presented = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
      if (!sameSecret(presented, options.token)) {
        options.onRefused?.(presented === '' ? 'no bearer token' : 'wrong bearer token');
        return refusal(401, 'A valid bearer token is required.', { 'www-authenticate': 'Bearer realm="agenttrust"' });
      }

      return handler.fetch(request);
    },
  };
}
