import { OpenPanelComponent } from '@openpanel/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './globals.css';

const sans = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
});

const mono = Geist_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
});

const display = localFont({
  src: './fonts/DepartureMono-Regular.woff2',
  variable: '--font-display',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://openqueue.dev'),
  title: {
    default: 'OpenQueue — Background jobs for TypeScript, batteries included',
    template: '%s — OpenQueue',
  },
  description:
    'A batteries-included background job framework on BullMQ + Redis. Typed tasks, retries, cron, flows, and a built-in dashboard — one config file, one CLI, zero glue code.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${display.variable} dark h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <OpenPanelComponent
          clientId={process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID!}
          trackScreenViews
          trackOutgoingLinks
          trackAttributes
        />
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
