import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label so the message can name which area failed. */
  area?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle/effect errors in the subtree and shows a readable
 * error card instead of blanking the whole window. Without this, a single
 * throwing IPC call or bad render leaves the user staring at an empty screen
 * with no indication of what went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so it shows up in devtools / logs.
    console.error('[Starlight] Uncaught UI error:', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="flex items-center justify-center h-full p-6">
        <div className="max-w-md flex flex-col items-start px-6 py-5 rounded-md border border-neon-pink/50 bg-panel/95">
          <h2 className="text-base font-semibold text-neon-pink">
            Something went wrong{this.props.area ? ` in ${this.props.area}` : ''}
          </h2>
          <p className="text-xs text-muted mt-2 max-w-[420px]">
            The view hit an unexpected error. The rest of the app is still running —
            you can retry or switch to another tab.
          </p>
          <pre className="text-[10px] text-muted/80 mt-3 max-w-[420px] whitespace-pre-wrap break-words">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="mt-3 px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
