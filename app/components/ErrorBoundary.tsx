import { Component, type ErrorInfo, type ReactNode } from "react";

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Hyron screen error", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="empty-state">
          <h1>This view could not load.</h1>
          <p>Your saved reports are still on the server.</p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            Reload Hyron
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
