import { Component, type ErrorInfo, type ReactNode } from "react";
import type { RendererErrorReport } from "../../../../shared/renderer-error";
import {
  createRendererErrorReport,
  reportRendererError,
} from "../../lib/renderer-error-reporting";

type RendererErrorBoundaryProps = {
  children: ReactNode;
};

type RendererErrorBoundaryState = {
  report?: RendererErrorReport;
};

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  override state: RendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return {
      report: createRendererErrorReport("error-boundary", error),
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    const report = createRendererErrorReport("error-boundary", error, {
      componentStack: errorInfo.componentStack,
    });
    this.setState({ report });
    reportRendererError(report);
  }

  override render() {
    if (this.state.report) {
      return (
        <main className="renderer-error-boundary" role="alert">
          <p className="eyebrow">PwrAgent</p>
          <h1>Renderer error</h1>
          <p>
            The desktop renderer hit an unrecoverable UI error. Details were logged for
            diagnosis.
          </p>
          <pre>{this.state.report.message}</pre>
        </main>
      );
    }

    return this.props.children;
  }
}

