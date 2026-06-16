import { WindowFrame } from './window-frame';

const NODES = [
  { name: 'validate-cart', duration: '42ms', x: 3, y: 8 },
  { name: 'charge-card', duration: '612ms', x: 3, y: 42 },
  { name: 'reserve-stock', duration: '118ms', x: 3, y: 76 },
  { name: 'email-receipt', duration: '287ms', x: 38, y: 8 },
  { name: 'generate-pdf', duration: '894ms', x: 38, y: 42 },
  { name: 'notify-warehouse', duration: '71ms', x: 38, y: 76 },
  { name: 'finalize', duration: '33ms', x: 73, y: 42, highlight: true },
];

const EDGES = [
  'M27,14 L37,14',
  'M27,48 L37,48',
  'M27,82 L37,82',
  'M62,14 C68,14 67,46 72,47',
  'M62,48 L72,48',
  'M62,82 C68,82 67,50 72,49',
];

export function MockFlow() {
  return (
    <WindowFrame title="order-fulfillment · flow_4f12">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div>
          <p className="text-xs font-medium text-neutral-100">
            order-fulfillment
          </p>
          <p className="font-mono text-[10px] text-neutral-500">
            flow_4f12 · 7 jobs · 2.4s total
          </p>
        </div>
        <span className="border border-emerald-500/40 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
          ✓ completed
        </span>
      </div>
      <div className="relative aspect-[16/8] w-full p-2">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          {EDGES.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="#3f3f46"
              strokeWidth="0.4"
            />
          ))}
        </svg>
        {NODES.map((node) => (
          <div
            key={node.name}
            className={`absolute w-[24%] border bg-[#0e0e10] px-2 py-1.5 ${
              node.highlight ? 'border-emerald-500/50' : 'border-white/10'
            }`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <p className="truncate font-mono text-[10px] text-neutral-200">
              <span className="mr-1.5 inline-block size-1.5 bg-emerald-400" />
              {node.name}
            </p>
            <p className="flex justify-between pt-0.5 font-mono text-[9px] text-neutral-600">
              completed <span>{node.duration}</span>
            </p>
          </div>
        ))}
      </div>
    </WindowFrame>
  );
}
