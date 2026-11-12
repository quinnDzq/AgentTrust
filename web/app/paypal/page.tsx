import type { Metadata } from 'next';
import { VerifyPage } from '@/components/VerifyPage';

export const metadata: Metadata = {
  title: 'AgentTrust · Live verification',
  description: 'Watch an agent’s purchase pass the model signal, the registered key and the buyer’s grant before a PayPal Sandbox payment.',
};

export default function PayPalPage() {
  return <VerifyPage view="verification" />;
}
