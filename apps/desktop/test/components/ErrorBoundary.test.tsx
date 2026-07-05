import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../../src/renderer/components/ErrorBoundary.js';

function Boom({ crash }: { crash: boolean }): JSX.Element {
  if (crash) throw new Error('kaboom');
  return <div>all good</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught errors to console.error; silence it for clean output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom crash={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('shows a readable error card (not a blank screen) when a child throws', () => {
    render(
      <ErrorBoundary area="this view">
        <Boom crash={true} />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong in this view');
    expect(alert).toHaveTextContent('kaboom');
  });

  it('recovers when Retry is clicked and the child no longer throws', () => {
    function Wrapper(): JSX.Element {
      return (
        <ErrorBoundary>
          <Boom crash={shouldCrash} />
        </ErrorBoundary>
      );
    }
    let shouldCrash = true;
    const { rerender } = render(<Wrapper />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Stop the child from throwing, then reset the boundary so it re-renders
    // the (now healthy) child.
    shouldCrash = false;
    rerender(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
