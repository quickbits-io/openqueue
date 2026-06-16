import type { ReactNode } from 'react';

export function WindowFrame({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden border border-white/15 bg-[#0b0b0c] shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8)] ${className}`}
    >
      <div className="relative flex h-9 items-center border-b border-white/10 px-3.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="absolute inset-x-0 text-center font-mono text-[11px] text-neutral-500">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}
