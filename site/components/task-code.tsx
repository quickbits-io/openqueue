const K = ({ children }: { children: string }) => (
  <span className="text-sky-300">{children}</span>
);
const S = ({ children }: { children: string }) => (
  <span className="text-emerald-300">{children}</span>
);
const P = ({ children }: { children: string }) => (
  <span className="text-neutral-400">{children}</span>
);
const C = ({ children }: { children: string }) => (
  <span className="text-neutral-600">{children}</span>
);
const N = ({ children }: { children: string }) => (
  <span className="text-amber-300">{children}</span>
);

export function TaskCode() {
  return (
    <div className="overflow-hidden border border-white/15 bg-[#0b0b0c]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-[11px] text-neutral-500">
          worker/export-csv.ts
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          typescript
        </span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-neutral-200">
        <code>
          <K>import</K> {'{ task }'} <K>from</K> <S>'@openqueue/sdk'</S>
          {';\n'}
          <K>import</K> {'{ z }'} <K>from</K> <S>'zod'</S>
          {';\n\n'}
          <K>export const</K> exportCsv <P>=</P> <N>task</N>
          {'({\n  '}
          <P>id:</P> <S>'export-csv'</S>
          {',\n  '}
          <P>schema:</P> z.<N>object</N>
          {'({\n    '}
          <P>reportId:</P> z.<N>string</N>
          {'(),\n    '}
          <P>format:</P> z.<N>enum</N>
          {'(['}
          <S>'csv'</S>
          {', '}
          <S>'xlsx'</S>
          {']),\n  }),\n  '}
          <P>attempts:</P> <N>5</N>
          {',\n  '}
          <P>backoff:</P>
          {' { '}
          <P>type:</P> <S>'exponential'</S>
          {', '}
          <P>delay:</P> <N>1000</N>
          {' },\n  '}
          <P>run:</P> <K>async</K> (payload, ctx) <P>{'=>'}</P>
          {' {\n    '}
          ctx.logger.<N>info</N>
          {'('}
          <S>'building report'</S>
          {', { '}
          <P>id:</P> payload.reportId
          {' });\n    '}
          <K>const</K> file <P>=</P> <K>await</K> <N>build</N>
          {'(payload);\n    '}
          <K>await</K> ctx.<N>progress</N>
          {'({ '}
          <P>step:</P> <S>'uploading'</S>
          {' });\n    '}
          <K>return</K>
          {' { '}
          <P>url:</P> file.url
          {' };\n  },\n});\n\n'}
          <C>{'// anywhere in your app — typed, validated, durable'}</C>
          {'\n'}
          <K>await</K> exportCsv.<N>trigger</N>
          {'({ '}
          <P>reportId:</P> <S>'rep_812'</S>
          {', '}
          <P>format:</P> <S>'csv'</S>
          {' });\n'}
        </code>
      </pre>
    </div>
  );
}
