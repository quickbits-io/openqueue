'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import {
  type HeaderSource,
  setApiBase,
  setApiRoot,
  setRequestHeaders,
} from './lib/api-base';
import {
  type WorkbenchNavigation,
  WorkbenchNavigationProvider,
} from './navigation';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 5,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export interface WorkbenchProviderProps {
  children: React.ReactNode;
  apiBase?: string;
  apiRoot?: string;
  headers?: HeaderSource;
  navigation?: WorkbenchNavigation;
}

export function WorkbenchProvider({
  children,
  apiBase,
  apiRoot,
  headers,
  navigation,
}: WorkbenchProviderProps) {
  if (apiRoot !== undefined) {
    setApiRoot(apiRoot);
  } else if (apiBase !== undefined) {
    setApiBase(apiBase);
  }

  if (headers !== undefined) {
    setRequestHeaders(headers);
  }

  const content = (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        {children}
        <Toaster position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );

  if (!navigation) return content;

  return (
    <WorkbenchNavigationProvider navigation={navigation}>
      {content}
    </WorkbenchNavigationProvider>
  );
}
