'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Film } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  context?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global Error Boundary component for catching React component errors.
 * Use this to wrap client components that might crash, especially the video player.
 *
 * @example
 * ```tsx
 * <ErrorBoundary context="VideoPlayer">
 *   <VideoPlayer {...props} />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `ErrorBoundary${this.props.context ? ` [${this.props.context}]` : ''} caught an error:`,
      error,
      errorInfo
    );
    this.props.onError?.(error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback
          error={this.state.error}
          context={this.props.context}
          onReset={this.handleReset}
          onReload={this.handleReload}
        />
      );
    }

    return this.props.children;
  }
}

interface ErrorFallbackProps {
  error: Error | null;
  context?: string;
  onReset: () => void;
  onReload: () => void;
}

function ErrorFallback({ error, context, onReset, onReload }: ErrorFallbackProps) {
  const isVideoContext = context?.toLowerCase().includes('video');

  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center">
      <div className="relative">
        {isVideoContext ? (
          <>
            <Film className="h-12 w-12 text-muted-foreground" />
            <AlertTriangle className="absolute -bottom-1 -right-1 h-6 w-6 text-destructive" />
          </>
        ) : (
          <AlertTriangle className="h-12 w-12 text-destructive" />
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-lg font-semibold">
          {context ? `${context} crashed` : 'Something went wrong'}
        </h3>
        <p className="text-muted-foreground text-sm max-w-sm">
          {isVideoContext
            ? 'The video player encountered an error. Try reloading or go back to the project.'
            : 'An unexpected error occurred. Try resetting the component or reload the page.'}
        </p>
      </div>

      {process.env.NODE_ENV === 'development' && error?.message && (
        <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono max-w-sm overflow-auto">
          {error.message}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={onReset} variant="default" size="sm">
          Try again
        </Button>
        <Button onClick={onReload} variant="outline" size="sm">
          Reload page
        </Button>
      </div>
    </div>
  );
}

/**
 * HOC to wrap a component with ErrorBoundary
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<Props, 'children'>
) {
  return function WithErrorBoundaryWrapper(props: P) {
    return (
      <ErrorBoundary {...errorBoundaryProps}>
        <Component {...props} />
      </ErrorBoundary>
    );
  };
}
