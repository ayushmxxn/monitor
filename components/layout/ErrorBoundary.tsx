import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { AppError } from '@/lib/errors';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional label shown in the fallback UI, e.g. "panel" or "settings". */
  scope?: string;
}

interface ErrorBoundaryState {
  error: AppError | null;
}

/**
 * Top-level error boundary for each extension surface (panel,
 * options). Extension UIs have no browser chrome to fall back on - an
 * uncaught render error would otherwise show a blank screen with no way
 * to recover, so every entrypoint's `App` should be wrapped in this.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: AppError.from(error) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}]`, error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="max-w-[28ch] text-xs text-muted-foreground">
            {error.toDisplayMessage()}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={this.handleReset}>
          Try again
        </Button>
      </div>
    );
  }
}
