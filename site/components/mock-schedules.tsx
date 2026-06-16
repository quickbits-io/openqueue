import { WindowFrame } from './window-frame';

const SCHEDULES = [
  { name: 'weekly-digest', cron: '0 9 * * MON', next: 'in 2d 4h', last: 'ok · 1.2s', paused: false },
  { name: 'cleanup-stale', cron: '*/15 * * * *', next: 'in 4m', last: 'ok · 87ms', paused: false },
  { name: 'reindex-search', cron: '0 */6 * * *', next: 'in 1h 12m', last: 'ok · 4.7s', paused: false },
  { name: 'trial-reminders', cron: '0 10 * * *', next: 'in 18h', last: 'ok · 612ms', paused: false },
  { name: 'rotate-creds', cron: '0 0 1 * *', next: 'in 6d', last: 'ok · 28ms', paused: true },
  { name: 'warm-cache', cron: '*/5 * * * *', next: 'in 2m', last: 'ok · 142ms', paused: false },
];

export function MockSchedules() {
  return (
    <WindowFrame title="my-app · 6 schedules">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <p className="text-xs font-medium text-neutral-100">Schedules</p>
        <p className="font-mono text-[10px] text-neutral-500">
          5 active · next: in 2m
        </p>
      </div>
      <table className="w-full table-fixed text-left font-mono text-[11px]">
        <colgroup>
          <col className="w-9" />
          <col />
          <col className="w-[104px] max-sm:hidden" />
          <col className="w-[72px]" />
          <col className="w-[88px]" />
        </colgroup>
        <thead>
          <tr className="border-b border-white/10 text-[9px] uppercase tracking-[0.2em] text-neutral-600">
            <th />
            <th className="py-2 pr-3 font-normal">Name</th>
            <th className="py-2 pr-3 font-normal max-sm:hidden">Cron</th>
            <th className="py-2 pr-3 font-normal">Next</th>
            <th className="py-2 pr-4 text-right font-normal">Last run</th>
          </tr>
        </thead>
        <tbody>
          {SCHEDULES.map((s) => (
            <tr key={s.name} className="border-b border-white/5">
              <td className="py-2 text-center text-[8px]">
                <span
                  className={s.paused ? 'text-neutral-600' : 'text-emerald-400'}
                >
                  {s.paused ? '❚❚' : '▶'}
                </span>
              </td>
              <td className="truncate py-2 pr-3 text-neutral-300">{s.name}</td>
              <td className="py-2 pr-3 text-neutral-500 max-sm:hidden">
                {s.cron}
              </td>
              <td className="py-2 pr-3 text-neutral-400">{s.next}</td>
              <td className="py-2 pr-4 text-right text-neutral-500">
                {s.last}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WindowFrame>
  );
}
