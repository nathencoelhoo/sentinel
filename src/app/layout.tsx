import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'SENTINEL: real-time market anomaly detection',
  description: 'Ensemble of robust statistical detectors on live crypto streams. Research tool, not financial advice.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
