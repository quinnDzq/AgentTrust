import type { Metadata } from 'next';
import { VerifyPage } from '@/components/VerifyPage';

export const metadata: Metadata = {
  title: 'AgentTrust · Live Wallet',
  description: 'Connect a PayPal Sandbox wallet, approve a spending budget and enroll the agent.',
};

export default function WalletPage() {
  return <VerifyPage view="wallet" />;
}
