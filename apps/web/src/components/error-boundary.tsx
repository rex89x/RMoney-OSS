import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { logError } from '@/lib/error-log';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  scope?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}]`, error, info);
    void logError({
      scope: this.props.scope ?? 'unknown',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-[40vh] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-6" />
            </div>
            <h2 className="text-lg font-semibold">發生錯誤</h2>
            <p className="text-sm text-muted-foreground">
              {this.props.scope ? `功能 ${this.props.scope} ` : ''}遇到了無法恢復的錯誤。
            </p>
            <code className="w-full overflow-x-auto rounded-md bg-muted p-2 text-left text-xs">
              {error.message}
            </code>
            <div className="flex gap-2">
              <Button onClick={this.reset} variant="outline">
                <RefreshCw className="size-4" /> 重試
              </Button>
              <Button onClick={() => window.location.reload()}>整頁重新載入</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
