import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoMark, Wordmark } from '@/components/wordmark';
import { GITHUB_URL } from '@/lib/layout.shared';

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#060606]/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" aria-label="openqueue">
            <Wordmark className="h-[18px] w-auto" />
          </Link>
          <nav className="flex items-center gap-6 font-mono text-[12px] uppercase tracking-wider text-neutral-400">
            <Link href="/docs" className="transition-colors hover:text-neutral-100">
              Docs
            </Link>
            <Link
              href="/docs/quickstart"
              className="transition-colors hover:text-neutral-100"
            >
              Quickstart
            </Link>
            <a
              href={GITHUB_URL}
              className="transition-colors hover:text-neutral-100"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <LogoMark className="h-5 w-auto" />
              <Wordmark className="h-3.5 w-auto" />
              <span className="pl-2 font-mono text-[11px] text-neutral-600">
                MIT licensed
              </span>
            </div>
            <nav className="flex gap-6 font-mono text-[12px] uppercase tracking-wider text-neutral-500">
              <Link href="/docs" className="transition-colors hover:text-neutral-200">
                docs
              </Link>
              <a
                href={GITHUB_URL}
                className="transition-colors hover:text-neutral-200"
              >
                github
              </a>
              <a
                href="https://www.npmjs.com/package/@openqueue/sdk"
                className="transition-colors hover:text-neutral-200"
              >
                npm
              </a>
            </nav>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-6 font-mono text-[11px] text-neutral-600">
            <p>
              Hat tip to{' '}
              <a
                href="https://github.com/pontusab/workbench"
                className="text-neutral-500 transition-colors hover:text-neutral-300"
              >
                pontusab/workbench
              </a>{' '}
              for raising the bar on queue dashboards. OpenQueue is the whole
              suite.
            </p>
            <p>
              Powers{' '}
              <a
                href="https://expensicat.com"
                className="text-neutral-500 transition-colors hover:text-neutral-300"
              >
                Expensicat
              </a>{' '}
              · by{' '}
              <a
                href="https://quickbits.io"
                className="text-neutral-500 transition-colors hover:text-neutral-300"
              >
                Quickbits
              </a>{' '}
              · made in Tallinn
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
