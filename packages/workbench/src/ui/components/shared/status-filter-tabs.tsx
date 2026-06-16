import { MoreHorizontal } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { JobStatus } from '@/core/types';
import { cn } from '@/lib/utils';

export type StatusFilterValue = JobStatus | 'all';

export const STATUS_FILTER_OPTIONS: {
  value: StatusFilterValue;
  label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'waiting-children', label: 'Waiting Children' },
  { value: 'prioritized', label: 'Prioritized' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'delayed', label: 'Delayed' },
];

const PRIMARY_STATUS_VALUES: StatusFilterValue[] = ['all', 'active', 'failed'];

const primaryOptions = STATUS_FILTER_OPTIONS.filter((option) =>
  PRIMARY_STATUS_VALUES.includes(option.value),
);

const secondaryOptions = STATUS_FILTER_OPTIONS.filter(
  (option) => !PRIMARY_STATUS_VALUES.includes(option.value),
);

interface StatusFilterTabsProps {
  value: StatusFilterValue;
  onValueChange: (value: StatusFilterValue) => void;
  className?: string;
}

export function StatusFilterTabs({
  value,
  onValueChange,
  className,
}: StatusFilterTabsProps) {
  const activeSecondary = secondaryOptions.find(
    (option) => option.value === value,
  );

  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as StatusFilterValue)}
      className={className}
    >
      <TabsList>
        {primaryOptions.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                activeSecondary
                  ? `Status: ${activeSecondary.label}`
                  : 'More statuses'
              }
              className={cn(
                'inline-flex h-full items-center justify-center whitespace-nowrap px-2 py-1 text-sm font-medium transition-all',
                'focus-visible:outline-none',
                activeSecondary && 'bg-background text-foreground shadow-sm',
              )}
            >
              {activeSecondary ? (
                <span className="max-w-[6.5rem] truncate px-1">
                  {activeSecondary.label}
                </span>
              ) : (
                <MoreHorizontal className="h-4 w-4" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {secondaryOptions.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => onValueChange(option.value)}
                className={cn(value === option.value && 'bg-accent')}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TabsList>
    </Tabs>
  );
}
