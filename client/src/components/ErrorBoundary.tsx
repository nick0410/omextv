import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence against a white screen.
 *
 * React unmounts the whole tree when a render throws, so one bad value —
 * `undefined.map()` from an unexpected API response, say — takes the entire
 * page down and leaves nothing on screen to explain it. Showing the message
 * costs the user nothing and turns "the site is broken" into something
 * actionable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[omextv] render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center px-5">
        <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.06)]">
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">
            Something went wrong
          </h1>
          <p className="mt-2 break-words text-sm text-ink-500">{error.message}</p>
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="mt-5 w-full rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
