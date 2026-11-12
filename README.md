# AgentTrust

AgentTrust checks an AI agent’s identity and spending authorization before it submits a PayPal Sandbox payment. The buyer connects a Sandbox wallet, approves a spending cap and reviews purchases that cross the approval threshold. The verification page shows the signed request, the decision and the capture receipt.

The default identity is an enrolled Ed25519 public key. ERC-8004 testnet registration is optional. The connector uses a numeric challenge and a bank of reference replies to decide whether to offer a signing challenge.

## Set up PayPal Sandbox

1. In the PayPal Developer Dashboard, select **Sandbox**, then open **Apps & Credentials**. Choose or create a REST app for a Sandbox **Business** account and enable payment acceptance and Vault. Copy the app’s **Client ID** and **Client Secret** into `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET` in your local `.env`. [PayPal Vault setup](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal)
2. In **Testing Tools → Sandbox Accounts**, create or choose a **Personal** Sandbox account. Use its email and password in the PayPal authorization window after clicking **Connect PayPal Sandbox**. [PayPal Sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts)
3. For a hosted instance, configure the two REST app values as server secrets. Keep the buyer login with the people authorized to use it. The tracked `.env.example` contains the configuration names.

## Run locally

Install Bun and Node.js. The web build downloads its fonts from Google Fonts.

Run these commands from the repository root.

```sh
cp .env.example .env
(cd app && bun install --frozen-lockfile)
(cd web && bun install --frozen-lockfile && bun run build)
```

Fill in `.env`, then start the signer and the app in separate terminals.

```sh
cd app && bun run signer
```

```sh
cd app && bun run dev
```

Open [the verification page](http://localhost:8787/verify/paypal/). Connect the Sandbox wallet, approve the budget and enroll the agent. **Prove identity** verifies a fresh challenge using the enrolled key. Sandbox payments use test funds.

## Connect an agent

The app listens locally on port 8787, the signer on 8788, and the MCP connector on 8789. Point the agent platform to the connector’s `/mcp` URL and send the bearer token generated in `app/keys/connector.local.json` or set in `AGENTTRUST_MCP_TOKEN`. If the platform runs remotely, tunnel only port 8789 over HTTPS. Keep the buyer controls and signer on a trusted network. If you host the buyer page, put it behind access control for the authorized buyer.

A fresh checkout has an empty model reference bank. To collect references from the target agent, start the app with `AGENTTRUST_CALIBRATE_AS="<model-label>"` and have the agent use `begin_verification` and `submit_model_reply` for at least six independent replies. Calibration records responses without signing a payment. Run `bun run calibrate` from `app/` to inspect the bank, then unset `AGENTTRUST_CALIBRATE_AS` and restart. A matching reference is required to reach signing. The model signal grants no spending authority. The enrolled key and the buyer’s grant determine whether a signed request can proceed.

Use `get_connector_status` to check wallet, grant, enrollment, signer and model reference readiness. For a purchase, the agent calls `begin_verification`, `submit_model_reply` and `sign_and_submit`, then uses `get_purchase_status` to read the result. When additional approval is required, the buyer decides on the verification page. The connector can request a budget change, and the buyer approves or declines it on the same page.

### Optional ERC-8004 enrollment

With the signer running, use `bun run erc8004 file` from `app/` to generate registration metadata. Register the agent with a testnet wallet, then set `AGENTTRUST_IDENTITY_MODE=erc8004`, `AGENTTRUST_ERC8004_NETWORK`, `AGENTTRUST_ERC8004_AGENT_ID` and `AGENTTRUST_ERC8004_OWNER`. Run `bun run erc8004 check`, restart the app and enroll the agent on the verification page.

## Checks

```sh
(cd app && bun run check && bun test)
(cd web && bun test && bun run build)
```

[MIT license](LICENSE)
