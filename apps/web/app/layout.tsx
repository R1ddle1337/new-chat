import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import TopNav from './components/top-nav';

const headingFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
});

const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

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
      <body className={`${headingFont.variable} ${monoFont.variable}`}>
        <div className="shell">
          <header className="topbar">
            <div className="brand">new-chat</div>
            <TopNav />
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
