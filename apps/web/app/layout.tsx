import type { Metadata } from 'next';
import './globals.css';
import AppShell from './components/app-shell';

export const metadata: Metadata = {
  title: 'New Chat MVP',
  description: 'Web chat gateway with BYOK + multi-provider support.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
