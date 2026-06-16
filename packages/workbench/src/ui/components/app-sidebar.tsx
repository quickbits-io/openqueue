'use client';

import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bell,
  Bug,
  Clock,
  FlaskConical,
  Hourglass,
  Layers,
  LayoutDashboard,
  Moon,
  MoreHorizontal,
  Network,
  PanelLeft,
  Pause,
  Play,
  Sun,
  Timer,
  XCircle,
  Zap,
} from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { WorkbenchLogo, WorkbenchWordmark } from '@/components/workbench-icon';
import { useQueueInfo } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export type NavItem =
  | 'overview'
  | 'runs'
  | 'errors'
  | 'metrics'
  | 'schedulers'
  | 'flows'
  | 'queues'
  | 'alerts'
  | 'test';

interface AppSidebarProps {
  queues: string[];
  pausedQueues?: Set<string>;
  activeNav: NavItem;
  activeQueue?: string;
  onNavSelect: (nav: NavItem) => void;
  onQueueSelect: (queue: string) => void;
  isDark: boolean;
  onToggleTheme: () => void;
  title?: string;
  logo?: string;
}

const mainNavItems = [
  { id: 'overview' as const, label: 'Jobs', icon: LayoutDashboard },
  { id: 'runs' as const, label: 'Runs', icon: Play },
  { id: 'errors' as const, label: 'Errors', icon: Bug },
  { id: 'metrics' as const, label: 'Metrics', icon: BarChart3 },
  { id: 'schedulers' as const, label: 'Schedulers', icon: Clock },
  { id: 'flows' as const, label: 'Flows', icon: Network },
  { id: 'alerts' as const, label: 'Alerts', icon: Bell },
  { id: 'test' as const, label: 'Test', icon: FlaskConical },
];

function QueueStatusDetails({ queueName }: { queueName: string }) {
  const queueInfo = useQueueInfo(queueName);

  if (!queueInfo) {
    return (
      <p className="text-xs text-muted-foreground">Loading queue stats…</p>
    );
  }

  const { counts } = queueInfo;
  const rows: { icon: LucideIcon; label: string; value: number }[] = [
    { icon: Zap, label: 'Active', value: counts.active },
    { icon: Hourglass, label: 'Waiting', value: counts.waiting },
    { icon: XCircle, label: 'Failed', value: counts.failed },
    { icon: Timer, label: 'Delayed', value: counts.delayed },
  ];

  const total =
    counts.waiting +
    counts.active +
    counts.completed +
    counts.failed +
    counts.delayed +
    counts.prioritized +
    counts['waiting-children'];

  if (total === 0) {
    return <p className="text-xs text-muted-foreground">Queue is empty</p>;
  }

  return (
    <div className="space-y-1.5">
      {rows.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{label}</span>
          <span className="font-mono tabular-nums text-foreground">
            {value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function QueueRow({
  queue,
  paused,
  active,
  onSelect,
}: {
  queue: string;
  paused: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted/50',
            active
              ? 'bg-muted/50 text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {queue}
          </span>
          {paused && (
            <Pause className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-40 p-3"
      >
        <p className="mb-2 truncate font-mono text-[11px] font-medium">
          {queue}
        </p>
        <QueueStatusDetails queueName={queue} />
      </HoverCardContent>
    </HoverCard>
  );
}

function QueueList({
  queues,
  pausedQueues,
  activeQueue,
  onQueueSelect,
  compact,
}: {
  queues: string[];
  pausedQueues: Set<string>;
  activeQueue?: string;
  onQueueSelect: (queue: string) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'space-y-0.5',
        compact
          ? 'mb-3 max-h-[calc(var(--radix-hover-card-content-available-height)-25px)] overflow-y-auto pr-0.5'
          : 'max-h-64 overflow-y-auto',
      )}
    >
      {queues.map((queue) => (
        <QueueRow
          key={queue}
          queue={queue}
          paused={pausedQueues.has(queue)}
          active={activeQueue === queue}
          onSelect={() => onQueueSelect(queue)}
        />
      ))}
    </div>
  );
}

function QueuesSection({
  queues,
  pausedQueues,
  activeQueue,
  onQueueSelect,
}: {
  queues: string[];
  pausedQueues: Set<string>;
  activeQueue?: string;
  onQueueSelect: (queue: string) => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-[10px] uppercase tracking-wider">
        Queues
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <QueueList
          queues={queues}
          pausedQueues={pausedQueues}
          activeQueue={activeQueue}
          onQueueSelect={onQueueSelect}
        />
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function CollapsedQueuesMenuItem({
  queues,
  pausedQueues,
  activeNav,
  activeQueue,
  onQueueSelect,
}: {
  queues: string[];
  pausedQueues: Set<string>;
  activeNav: NavItem;
  activeQueue?: string;
  onQueueSelect: (queue: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [panelPos, setPanelPos] = React.useState({ top: 0, left: 0 });
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const showPanel = () => {
    clearCloseTimer();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPanelPos({ top: rect.top, left: rect.right + 16 });
    }
    setOpen(true);
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        ref={buttonRef}
        tooltip="Queues"
        isActive={activeNav === 'queues' || !!activeQueue}
        onPointerEnter={showPanel}
        onPointerLeave={scheduleClose}
      >
        <Layers className="h-4 w-4" />
        <span>Queues</span>
      </SidebarMenuButton>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-50 w-auto min-w-[140px] max-w-[260px] overflow-hidden border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ top: panelPos.top, left: panelPos.left }}
            onPointerEnter={clearCloseTimer}
            onPointerLeave={scheduleClose}
          >
            <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Queues
            </div>
            <QueueList
              queues={queues}
              pausedQueues={pausedQueues}
              activeQueue={activeQueue}
              onQueueSelect={(queue) => {
                onQueueSelect(queue);
                setOpen(false);
              }}
              compact
            />
          </div>,
          document.body,
        )}
    </SidebarMenuItem>
  );
}

function SidebarMoreMenu({
  isDark,
  onToggleTheme,
}: {
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  const { open, toggleSidebar } = useSidebar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton tooltip="More">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">More</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-44 p-1"
      >
        <DropdownMenuItem
          className="gap-1.5 px-2 py-1 text-xs"
          onSelect={toggleSidebar}
        >
          <PanelLeft className="size-3.5" />
          {open ? 'Collapse sidebar' : 'Expand sidebar'}
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            ⌘B
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-1.5 px-2 py-1 text-xs"
          onSelect={onToggleTheme}
        >
          {isDark ? (
            <Sun className="size-3.5" />
          ) : (
            <Moon className="size-3.5" />
          )}
          {isDark ? 'Light mode' : 'Dark mode'}
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            ⌘⇧T
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({
  queues,
  pausedQueues = new Set(),
  activeNav,
  activeQueue,
  onNavSelect,
  onQueueSelect,
  isDark,
  onToggleTheme,
  logo,
}: AppSidebarProps) {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <Sidebar collapsible="icon" variant="sidebar" className="border-r-0">
      <SidebarHeader className="h-14 flex-row items-center border-b border-border p-0">
        <button
          type="button"
          onClick={() => onNavSelect('overview')}
          aria-label="Go to Jobs"
          className={cn(
            'flex h-14 min-w-0 items-center transition-colors hover:bg-sidebar-accent/50',
            isCollapsed
              ? 'w-[var(--sidebar-width-icon)] shrink-0 justify-center'
              : 'gap-2 px-2',
          )}
        >
          <WorkbenchLogo src={logo} />
          {!isCollapsed && (
            <WorkbenchWordmark className="min-w-0 truncate pr-3" />
          )}
        </button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="sr-only">Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeNav === item.id}
                    tooltip={item.label}
                    onClick={() => onNavSelect(item.id)}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {isCollapsed && (
                <CollapsedQueuesMenuItem
                  queues={queues}
                  pausedQueues={pausedQueues}
                  activeNav={activeNav}
                  activeQueue={activeQueue}
                  onQueueSelect={onQueueSelect}
                />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!isCollapsed && (
          <>
            <SidebarSeparator />

            <QueuesSection
              queues={queues}
              pausedQueues={pausedQueues}
              activeQueue={activeQueue}
              onQueueSelect={onQueueSelect}
            />
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMoreMenu isDark={isDark} onToggleTheme={onToggleTheme} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
