import type { Metadata } from 'next';
import {
  Atkinson_Hyperlegible_Mono,
  Atkinson_Hyperlegible_Next,
  Pixelify_Sans,
  Press_Start_2P,
} from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const display = Pixelify_Sans({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const body = Atkinson_Hyperlegible_Next({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['system-ui', 'sans-serif'],
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['monospace'],
});
const pixel = Press_Start_2P({ subsets: ['latin'], weight: '400', variable: '--font-pixel', display: 'swap' });

export const metadata: Metadata = {
  title: 'AgentTrust · Wallet verification',
  description:
    'Verify an agent’s identity and spending authorization for a PayPal Sandbox payment.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${pixel.variable}`}>
      <body className="bg-bg text-ink font-body antialiased">{children}</body>
    </html>
  );
}
