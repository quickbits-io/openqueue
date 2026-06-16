import type { TaskLogger } from './types';

export function consoleLogger(prefix: string): TaskLogger {
  const build =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (message: string, attrs?: Record<string, unknown>) => {
      const line = attrs
        ? `[${prefix}] ${message} ${JSON.stringify(attrs)}`
        : `[${prefix}] ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else if (level === 'debug') console.debug(line);
      else console.log(line);
    };
  return {
    info: build('info'),
    warn: build('warn'),
    error: build('error'),
    debug: build('debug'),
  };
}
