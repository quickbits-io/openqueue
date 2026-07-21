import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyCommand } from '@/components/copy-command';
import { MockErrors } from '@/components/mock-errors';
import { MockFlow } from '@/components/mock-flow';
import { MockOverview } from '@/components/mock-overview';
import { MockRuns } from '@/components/mock-runs';
import { MockSchedules } from '@/components/mock-schedules';
import { MockTerminal } from '@/components/mock-terminal';
import { StackRow } from '@/components/stack-row';
import { TaskCode } from '@/components/task-code';

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-neutral-500">
      <span className="mr-2 inline-block size-1.5 bg-emerald-400" />
      {children}
    </p>
  );
}

const GRID_FEATURES = [
  {
    title: 'Typed payloads',
    body: 'Give a task a Zod schema and payloads are validated at trigger time and fully typed inside run — no any, no guessing.',
  },
  {
    title: 'Retries with taste',
    body: 'Exponential backoff by default. Throw NonRetryableError to stop, RetryableError to keep going — control flow, not string matching.',
  },
  {
    title: 'Cron + live schedules',
    body: 'Declare cron on the task, or create, list, and pause schedules at runtime through the schedules API. No redeploy to change a cadence.',
  },
  {
    title: 'Flows & DAGs',
    body: 'Compose parent/child trees with enqueueFlow and task.child. Per-node status and duration, rendered as a real graph.',
  },
  {
    title: 'Workbench built in',
    body: 'Overview, runs, flows, schedules, errors, metrics, and a test console — served by your worker, or mounted in your own app.',
  },
  {
    title: 'Postgres run history',
    body: 'The Drizzle adapter persists runs, logs, and alerts past Redis retention. Your audit trail survives a FLUSHALL.',
  },
  {
    title: 'OpenTelemetry native',
    body: 'Trace context propagates from enqueue to process automatically. Plug in any exporter and see jobs inside your existing traces.',
  },
  {
    title: 'Hot-reload dev',
    body: 'openqueue dev watches your task files and restarts the worker in milliseconds. The dashboard reconnects on its own.',
  },
];

const SHOWCASE: Array<{
  label: string;
  title: string;
  body: string;
  mock: ReactNode;
  flip?: boolean;
}> = [
  {
    label: 'Runs',
    title: 'Inspect every run. Replay any failure.',
    body: 'Full payloads, attempt history, logs, and progress for every job. Filter by status, search by ID, retry from the UI — and keep history in Postgres long after Redis forgets.',
    mock: <MockRuns />,
  },
  {
    label: 'Errors',
    title: 'Triage failures, not log files.',
    body: 'Failures are grouped by error class, ranked by frequency, and trended over time — so a regression shows up as a spike the moment it ships, not as a support ticket three days later.',
    mock: <MockErrors />,
    flip: true,
  },
  {
    label: 'Flows',
    title: 'Pipelines as parent/child tasks.',
    body: 'enqueueFlow turns task.child trees into real DAGs with per-node status and duration. Drill into any node and see exactly where the time went.',
    mock: <MockFlow />,
  },
  {
    label: 'Schedules',
    title: 'Cron you can change without redeploying.',
    body: 'Declare cron on a task for static schedules, or create and pause them at runtime with task.schedules.create(). See what runs next, what ran last, and how long it took.',
    mock: <MockSchedules />,
    flip: true,
  },
];

const RUN_MODES = [
  {
    label: 'Develop',
    title: 'Next to your app',
    body: 'openqueue dev discovers tasks from your worker/ directory, hot-reloads on change, and serves Workbench locally. One process, no Docker, no YAML.',
    command: 'openqueue dev',
  },
  {
    label: 'Embed',
    title: 'Inside your server',
    body: 'Mount the dashboard in the app you already run. h3 and Next.js App Router adapters — or a plain fetch handler anywhere else — one catch-all route and Workbench shares your auth.',
    command: "import { workbench } from '…/next'",
  },
  {
    label: 'Ship',
    title: 'In a container',
    body: 'openqueue build compiles a self-contained Nitro server artifact; openqueue start runs it. Or point the prebuilt Docker worker at your Redis and go.',
    command: 'openqueue build && openqueue start',
  },
];

export default function HomePage() {
  return (
    <div className="overflow-x-clip">
      {/* Hero */}
      <section className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(74,222,128,0.07),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-6 pt-24 pb-16 text-center max-sm:pt-16">
          <h1 className="mx-auto max-w-4xl font-display text-6xl leading-[1.05] text-neutral-50 max-sm:text-4xl">
            Background jobs,
            <br />
            batteries included.
          </h1>
          <p className="mx-auto max-w-2xl pt-6 text-[15px] leading-relaxed text-neutral-400">
            OpenQueue is a TypeScript job framework built on BullMQ and Redis.
            Typed tasks, retries, cron, flows, and a dashboard you didn&apos;t
            have to build — one config file, one CLI, zero glue code.
          </p>
          <div className="flex items-center justify-center gap-3 pt-8 max-sm:flex-col">
            <Link
              href="/docs/quickstart"
              className="flex h-11 items-center bg-emerald-400 px-5 font-mono text-[12px] font-semibold uppercase tracking-wider text-black transition-colors hover:bg-emerald-300"
            >
              Get started →
            </Link>
            <CopyCommand command="bunx @openqueue/cli init" />
          </div>
          <p className="pt-6 font-mono text-[11px] text-neutral-600">
            MIT · built on BullMQ · runs on Bun &amp; Node
          </p>

          <div className="mx-auto max-w-4xl pt-16">
            <MockOverview />
          </div>

          <StackRow />
        </div>
      </section>

      {/* Tasks / code */}
      <section className="border-t border-white/10">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
          <div>
            <SectionLabel>Tasks</SectionLabel>
            <h2 className="pt-4 text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
              If you can write a function, you can ship a job.
            </h2>
            <p className="pt-5 text-[15px] leading-relaxed text-neutral-400">
              A task is an id, a schema, and a function. OpenQueue wires up the
              queue, the worker, validation, retries, backoff, and concurrency —
              then hands you a typed <code className="font-mono text-neutral-300">.trigger()</code> to
              call from anywhere in your app.
            </p>
            <ul className="space-y-3 pt-6 text-[14px] text-neutral-400">
              <li className="flex gap-3">
                <span className="text-emerald-400">→</span>
                Payloads validated by Zod before they ever hit Redis.
              </li>
              <li className="flex gap-3">
                <span className="text-emerald-400">→</span>
                Logs and progress stream straight into the dashboard.
              </li>
              <li className="flex gap-3">
                <span className="text-emerald-400">→</span>
                Defaults that make sense: 3 attempts, exponential backoff.
              </li>
            </ul>
          </div>
          <TaskCode />
        </div>
      </section>

      {/* Showcase sections */}
      {SHOWCASE.map((section) => (
        <section key={section.label} className="border-t border-white/10">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-[2fr_3fr]">
            <div className={section.flip ? 'lg:order-2' : ''}>
              <SectionLabel>{section.label}</SectionLabel>
              <h2 className="pt-4 text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
                {section.title}
              </h2>
              <p className="pt-5 text-[15px] leading-relaxed text-neutral-400">
                {section.body}
              </p>
            </div>
            <div className={section.flip ? 'lg:order-1' : ''}>
              {section.mock}
            </div>
          </div>
        </section>
      ))}

      {/* Feature grid */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <SectionLabel>What&apos;s inside</SectionLabel>
          <h2 className="max-w-2xl pt-4 text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
            Everything a job framework should do. Nothing it shouldn&apos;t.
          </h2>
          <p className="max-w-2xl pt-5 text-[15px] leading-relaxed text-neutral-400">
            No proprietary runtime, no per-job pricing, no second cloud. Your
            Redis, your Postgres, your code — OpenQueue just makes them feel
            like a product.
          </p>
          <div className="mt-14 grid grid-cols-4 gap-px border border-white/10 bg-white/10 max-lg:grid-cols-2 max-sm:grid-cols-1">
            {GRID_FEATURES.map((feature) => (
              <div key={feature.title} className="bg-[#0a0a0b] p-6">
                <h3 className="text-[14px] font-medium text-neutral-100">
                  {feature.title}
                </h3>
                <p className="pt-2.5 text-[13px] leading-relaxed text-neutral-500">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CLI */}
      <section className="border-t border-white/10">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
          <div>
            <SectionLabel>CLI</SectionLabel>
            <h2 className="pt-4 text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
              Four commands. That&apos;s the whole workflow.
            </h2>
            <p className="pt-5 text-[15px] leading-relaxed text-neutral-400">
              <code className="font-mono text-neutral-300">init</code> scaffolds
              a config and your first task.{' '}
              <code className="font-mono text-neutral-300">dev</code> runs the
              worker with hot reload.{' '}
              <code className="font-mono text-neutral-300">build</code> compiles
              a self-contained server artifact, and{' '}
              <code className="font-mono text-neutral-300">start</code> runs it
              in production. Failed runs retry with backoff and land in the
              dashboard — not in your logs at 3am.
            </p>
          </div>
          <MockTerminal />
        </div>
      </section>

      {/* Run modes */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <SectionLabel>Run it</SectionLabel>
          <h2 className="max-w-2xl pt-4 text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
            One worker. Three ways to run it.
          </h2>
          <div className="mt-14 grid gap-4 lg:grid-cols-3">
            {RUN_MODES.map((mode) => (
              <div
                key={mode.label}
                className="flex flex-col border border-white/10 bg-[#0a0a0b] p-6"
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-600">
                  {mode.label}
                </p>
                <h3 className="pt-3 text-lg font-medium text-neutral-100">
                  {mode.title}
                </h3>
                <p className="flex-1 pt-3 text-[13px] leading-relaxed text-neutral-500">
                  {mode.body}
                </p>
                <p className="mt-6 truncate border border-white/10 bg-[#060606] px-3 py-2 font-mono text-[11px] text-neutral-400">
                  <span className="text-neutral-600">$ </span>
                  {mode.command}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Proven in production */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <SectionLabel>Proven in production</SectionLabel>
          <div className="mt-4 grid items-end gap-10 lg:grid-cols-[3fr_2fr]">
            <div>
              <h2 className="text-4xl font-semibold tracking-tight text-neutral-50 max-sm:text-3xl">
                It already runs a business.
              </h2>
              <p className="max-w-xl pt-5 text-[15px] leading-relaxed text-neutral-400">
                OpenQueue handles every background job at Expensicat —
                invoicing, inbox OCR, bank sync, transaction matching,
                notifications. Same tasks, same retries, same Workbench you see
                above, in production around the clock.
              </p>
            </div>
            <a
              href="https://expensicat.com"
              className="group flex items-center gap-4 border border-white/10 bg-[#0a0a0b] p-6 transition-colors hover:border-white/20 lg:justify-self-end"
            >
              <Image
                src="/expensicat-mark.png"
                alt="Expensicat"
                width={40}
                height={42}
                className="h-10 w-auto opacity-90 transition-opacity group-hover:opacity-100"
              />
              <span className="flex flex-col">
                <span className="text-lg font-medium text-neutral-100">
                  Expensicat
                </span>
                <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500 transition-colors group-hover:text-neutral-300">
                  expensicat.com →
                </span>
              </span>
            </a>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-white/10">
        <div className="relative mx-auto max-w-6xl px-6 py-28 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[300px] bg-[radial-gradient(ellipse_50%_80%_at_50%_100%,rgba(74,222,128,0.06),transparent)]"
          />
          <h2 className="relative font-display text-5xl text-neutral-50 max-sm:text-3xl">
            Stop babysitting Redis.
          </h2>
          <p className="relative mx-auto max-w-xl pt-5 text-[15px] leading-relaxed text-neutral-400">
            You already run the infrastructure. OpenQueue turns it into a job
            platform — in about the time it takes your CI to go green.
          </p>
          <div className="relative flex items-center justify-center gap-3 pt-8 max-sm:flex-col">
            <Link
              href="/docs/quickstart"
              className="flex h-11 items-center bg-emerald-400 px-5 font-mono text-[12px] font-semibold uppercase tracking-wider text-black transition-colors hover:bg-emerald-300"
            >
              Read the quickstart →
            </Link>
            <CopyCommand command="bunx @openqueue/cli init" />
          </div>
        </div>
      </section>
    </div>
  );
}
