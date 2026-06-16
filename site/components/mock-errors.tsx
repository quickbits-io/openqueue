import { WindowFrame } from './window-frame';

const ERRORS = [
  { name: 'ECONNRESET', count: 184, trend: [3, 4, 3, 5, 4, 6, 9, 14, 12, 16] },
  { name: 'TimeoutError', count: 63, trend: [5, 4, 6, 5, 7, 5, 6, 5, 7, 6] },
  { name: 'ValidationError', count: 28, trend: [2, 3, 2, 4, 2, 3, 3, 2, 4, 3] },
  { name: 'S3AccessDenied', count: 12, trend: [1, 1, 2, 1, 1, 2, 1, 2, 1, 1] },
];

function sparkline(values: number[]) {
  const max = Math.max(...values);
  const step = 60 / (values.length - 1);
  return values
    .map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (18 - (v / max) * 14).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

export function MockErrors() {
  return (
    <WindowFrame title="my-app · errors · last 24h">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <p className="text-xs font-medium text-neutral-100">
          <span className="mr-2 text-red-400">⊘</span>Top errors · last 24h
        </p>
        <p className="font-mono text-[10px] text-neutral-500">287 events</p>
      </div>
      <ul className="divide-y divide-white/5 p-2">
        {ERRORS.map((error) => (
          <li
            key={error.name}
            className="flex items-center justify-between gap-4 px-2 py-2.5"
          >
            <span className="font-mono text-[11px] text-neutral-300">
              {error.name}
            </span>
            <span className="flex items-center gap-4">
              <svg
                viewBox="0 0 60 20"
                className="h-5 w-16"
                aria-hidden="true"
              >
                <path
                  d={sparkline(error.trend)}
                  fill="none"
                  stroke="#f87171"
                  strokeWidth="1.25"
                />
              </svg>
              <span className="w-8 text-right font-mono text-[11px] text-neutral-400">
                {error.count}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-white/10 px-4 py-2.5">
        <p className="font-mono text-[10px] text-neutral-600">
          ECONNRESET · exports ·{' '}
          <span className="text-red-400">spiking +240% vs yesterday</span> ·
          first seen 4h ago
        </p>
      </div>
    </WindowFrame>
  );
}
