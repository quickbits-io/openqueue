import { WindowFrame } from './window-frame';

type RunStatus = 'active' | 'completed' | 'failed' | 'delayed' | 'waiting';

const STATUS_STYLE: Record<RunStatus, { dot: string; text: string }> = {
  active: { dot: 'bg-sky-400', text: 'text-sky-400' },
  completed: { dot: 'bg-emerald-400', text: 'text-emerald-400' },
  failed: { dot: 'bg-red-400', text: 'text-red-400' },
  delayed: { dot: 'bg-neutral-500', text: 'text-neutral-500' },
  waiting: { dot: 'bg-amber-400', text: 'text-amber-400' },
};

const RUNS: Array<{
  id: string;
  name: string;
  status: RunStatus;
  duration: string;
  attempts: string;
  age: string;
}> = [
  { id: 'r_3aa18', name: 'export-csv', status: 'active', duration: '—', attempts: '1/3', age: 'now' },
  { id: 'r_3aa17', name: 'send-invoice', status: 'active', duration: '—', attempts: '1/3', age: '2s' },
  { id: 'r_3aa16', name: 'export-csv', status: 'completed', duration: '284ms', attempts: '1/3', age: '8s' },
  { id: 'r_3aa15', name: 'sync-contacts', status: 'completed', duration: '1.2s', attempts: '1/3', age: '14s' },
  { id: 'r_3aa14', name: 'export-csv', status: 'failed', duration: '1.8s', attempts: '3/3', age: '22s' },
  { id: 'r_3aa13', name: 'ocr-document', status: 'completed', duration: '612ms', attempts: '1/3', age: '31s' },
  { id: 'r_3aa12', name: 'send-invoice', status: 'completed', duration: '4.7s', attempts: '2/3', age: '44s' },
  { id: 'r_3aa11', name: 'send-receipt', status: 'delayed', duration: '—', attempts: '0/3', age: 'in 2m' },
  { id: 'r_3aa10', name: 'export-csv', status: 'completed', duration: '198ms', attempts: '1/3', age: '1m' },
  { id: 'r_3aa09', name: 'sync-contacts', status: 'waiting', duration: '—', attempts: '0/3', age: '1m' },
];

export function MockRuns() {
  return (
    <WindowFrame title="exports · last 50 runs">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <p className="text-xs font-medium text-neutral-100">
          Runs{' '}
          <span className="ml-1 border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            184,679
          </span>
        </p>
        <div className="flex gap-1 font-mono text-[10px] text-neutral-500 max-sm:hidden">
          <span className="border border-white/15 bg-white/5 px-1.5 py-0.5 text-neutral-200">
            All 184k
          </span>
          <span className="px-1.5 py-0.5">Active 47</span>
          <span className="px-1.5 py-0.5">Completed 184k</span>
          <span className="px-1.5 py-0.5">Failed 287</span>
        </div>
      </div>
      <table className="w-full table-fixed text-left font-mono text-[11px]">
        <colgroup>
          <col className="w-9" />
          <col className="w-[72px]" />
          <col />
          <col className="w-[72px] max-sm:hidden" />
          <col className="w-[72px] max-sm:hidden" />
          <col className="w-14" />
        </colgroup>
        <thead>
          <tr className="border-b border-white/10 text-[9px] uppercase tracking-[0.2em] text-neutral-600">
            <th />
            <th className="py-2 pr-3 font-normal">Job ID</th>
            <th className="py-2 pr-3 font-normal">Name</th>
            <th className="py-2 pr-3 font-normal max-sm:hidden">Duration</th>
            <th className="py-2 pr-3 font-normal max-sm:hidden">Attempts</th>
            <th className="py-2 pr-4 text-right font-normal">Age</th>
          </tr>
        </thead>
        <tbody>
          {RUNS.map((run) => {
            const style = STATUS_STYLE[run.status];
            return (
              <tr key={run.id} className="border-b border-white/5">
                <td className="py-1.5 text-center">
                  <span className={`inline-block size-1.5 ${style.dot}`} />
                </td>
                <td className="py-1.5 pr-3 text-neutral-500">{run.id}</td>
                <td className="truncate py-1.5 pr-3 text-neutral-300">
                  {run.name}{' '}
                  <span className={`ml-1 ${style.text}`}>{run.status}</span>
                </td>
                <td className="py-1.5 pr-3 text-neutral-400 max-sm:hidden">
                  {run.duration}
                </td>
                <td className="py-1.5 pr-3 text-neutral-400 max-sm:hidden">
                  {run.attempts}
                </td>
                <td className="py-1.5 pr-4 text-right text-neutral-500">
                  {run.age}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </WindowFrame>
  );
}
