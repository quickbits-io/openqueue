import { WindowFrame } from './window-frame';

const QUEUES = [
  { name: 'emails', count: 12 },
  { name: 'exports', count: 47, active: true },
  { name: 'billing', count: 3 },
  { name: 'webhooks', count: 18 },
];

const VIEWS = [
  { name: 'Overview', active: true },
  { name: 'Runs', count: 47 },
  { name: 'Flows' },
  { name: 'Schedules' },
  { name: 'Errors' },
  { name: 'Test' },
];

const STATS = [
  { label: 'completed', value: '184,392', delta: '+12.4%', tone: 'text-emerald-400' },
  { label: 'failed', value: '287', delta: '-3.1%', tone: 'text-red-400' },
  { label: 'active', value: '47', delta: '+8/min', tone: 'text-sky-400' },
  { label: 'waiting', value: '1,204', delta: 'stable', tone: 'text-amber-400' },
];

const COMPLETED = [
  18, 22, 20, 26, 24, 31, 28, 34, 30, 38, 35, 42, 39, 37, 45, 43, 50, 47, 54,
  51, 58, 55, 63, 60, 57, 66, 62, 70, 67, 74,
];

const FAILED = [
  6, 5, 7, 6, 8, 7, 6, 8, 7, 9, 8, 7, 9, 8, 10, 9, 8, 10, 9, 11, 10, 9, 11,
  10, 12, 11, 10, 12, 11, 13,
];

function linePath(values: number[], max: number, height: number, width: number) {
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (height - (v / max) * height).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

export function MockOverview() {
  const completedLine = linePath(COMPLETED, 80, 100, 300);
  const failedLine = linePath(FAILED, 80, 100, 300);

  return (
    <WindowFrame title="openqueue · my-app · 4 queues">
      <div className="grid grid-cols-[150px_1fr] max-sm:grid-cols-1 text-left">
        <aside className="border-r border-white/10 p-3 max-sm:hidden">
          <p className="px-2 pb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-neutral-600">
            Queues
          </p>
          <ul className="space-y-px">
            {QUEUES.map((q) => (
              <li
                key={q.name}
                className={`flex items-center justify-between px-2 py-1 font-mono text-[11px] ${
                  q.active ? 'bg-white/10 text-neutral-100' : 'text-neutral-500'
                }`}
              >
                {q.name}
                <span className="text-[10px] text-neutral-600">{q.count}</span>
              </li>
            ))}
          </ul>
          <p className="px-2 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-neutral-600">
            Views
          </p>
          <ul className="space-y-px">
            {VIEWS.map((v) => (
              <li
                key={v.name}
                className={`flex items-center justify-between px-2 py-1 text-[11px] ${
                  v.active ? 'bg-white/10 text-neutral-100' : 'text-neutral-500'
                }`}
              >
                {v.name}
                {v.count ? (
                  <span className="font-mono text-[10px] text-neutral-600">
                    {v.count}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </aside>

        <div className="p-4">
          <p className="text-sm font-medium text-neutral-100">exports</p>
          <p className="pt-0.5 font-mono text-[10px] text-neutral-500">
            47 active · 1,204 waiting · last 24h
          </p>

          <div className="mt-3 grid grid-cols-4 gap-2 max-sm:grid-cols-2">
            {STATS.map((s) => (
              <div
                key={s.label}
                className="border border-white/10 p-2.5"
              >
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600">
                  {s.label}
                </p>
                <p className="pt-1 font-mono text-base text-neutral-100">
                  {s.value}
                </p>
                <p className={`font-mono text-[10px] ${s.tone}`}>{s.delta}</p>
              </div>
            ))}
          </div>

          <div className="mt-2 border border-white/10 p-2.5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600">
                Throughput · jobs/min
              </p>
              <p className="font-mono text-[9px] text-neutral-600">
                <span className="text-emerald-400">■</span> completed{' '}
                <span className="text-red-400">■</span> failed
              </p>
            </div>
            <svg
              viewBox="0 0 300 100"
              preserveAspectRatio="none"
              className="mt-2 h-28 w-full"
              aria-hidden="true"
            >
              <path
                d={`${completedLine} L300,100 L0,100 Z`}
                fill="url(#mock-overview-fill)"
              />
              <path
                d={completedLine}
                fill="none"
                stroke="#4ade80"
                strokeWidth="1.5"
              />
              <path
                d={failedLine}
                fill="none"
                stroke="#f87171"
                strokeWidth="1"
              />
              <defs>
                <linearGradient
                  id="mock-overview-fill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#4ade80" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="flex items-center justify-between border border-white/10 px-2.5 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600">
                p50 wait
              </span>
              <span className="font-mono text-[11px] text-neutral-200">
                12ms
              </span>
            </div>
            <div className="flex items-center justify-between border border-white/10 px-2.5 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600">
                p95 duration
              </span>
              <span className="font-mono text-[11px] text-neutral-200">
                847ms
              </span>
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}
