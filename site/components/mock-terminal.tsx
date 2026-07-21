import { WindowFrame } from './window-frame';

export function MockTerminal() {
  return (
    <WindowFrame title="zsh — my-app">
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">
        <code>
          <span className="text-neutral-600">$</span>
          <span className="text-neutral-200"> bunx @openqueue/cli init</span>
          {'\n'}
          <span className="text-neutral-500">
            created worker.config.ts{'\n'}created worker/example.ts{'\n'}
          </span>
          <span className="text-emerald-400">OpenQueue initialized</span>
          {'\n\n'}
          <span className="text-neutral-600">$</span>
          <span className="text-neutral-200"> openqueue dev</span>
          {'\n'}
          <span className="text-neutral-500">
            [openqueue] 3 tasks · 2 queues · 1 schedule{'\n'}
            [openqueue] workbench on{' '}
          </span>
          <span className="text-sky-400">http://localhost:8090/workbench</span>
          {'\n'}
          <span className="text-neutral-500">
            [openqueue] watching ./worker for changes{'\n\n'}
          </span>
          <span className="text-emerald-400">✓</span>
          <span className="text-neutral-400"> export-csv </span>
          <span className="text-neutral-600">r_3aa16 · 284ms</span>
          {'\n'}
          <span className="text-emerald-400">✓</span>
          <span className="text-neutral-400"> sync-contacts </span>
          <span className="text-neutral-600">r_3aa15 · 1.2s</span>
          {'\n'}
          <span className="text-red-400">✗</span>
          <span className="text-neutral-400"> export-csv </span>
          <span className="text-neutral-600">
            r_3aa14 · attempt 2/3 · retrying in 2s
          </span>
          {'\n'}
        </code>
      </pre>
    </WindowFrame>
  );
}
