import { Component, type ErrorInfo, type ReactNode } from "react";
import type { RendererErrorReport } from "../../../../shared/renderer-error";
import {
  MAX_AUTOMATIC_RENDERER_RECOVERIES,
  RENDERER_RECOVERY_DELAY_MS,
} from "../../../../shared/renderer-recovery";
import {
  createRendererErrorReport,
  reportRendererError,
} from "../../lib/renderer-error-reporting";

type RendererErrorBoundaryProps = {
  children: ReactNode;
};

type RendererErrorBoundaryState = {
  report?: RendererErrorReport;
  recovering?: boolean;
};

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  override state: RendererErrorBoundaryState = {};
  private automaticAttempts = 0;
  private recoveryTimer?: ReturnType<typeof setTimeout>;

  static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return {
      report: createRendererErrorReport("error-boundary", error),
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    const report = createRendererErrorReport("error-boundary", error, {
      componentStack: errorInfo.componentStack,
    });
    const recovering = this.automaticAttempts < MAX_AUTOMATIC_RENDERER_RECOVERIES;
    if (recovering) this.automaticAttempts += 1;
    report.recovery = {
      action: recovering ? "automatic-remount" : "stopped",
      attempt: this.automaticAttempts,
      limit: MAX_AUTOMATIC_RENDERER_RECOVERIES,
    };
    // Capture both stacks before discarding the failed tree. Main owns the
    // bounded multiline logs; this does not restart any main-owned runtime.
    reportRendererError(report);
    this.clearRecoveryTimer();
    this.setState({ report, recovering });
    if (recovering) {
      this.recoveryTimer = setTimeout(this.remount, RENDERER_RECOVERY_DELAY_MS);
    }
  }

  override componentWillUnmount(): void {
    this.clearRecoveryTimer();
  }

  private clearRecoveryTimer = (): void => {
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  };

  private remount = (): void => {
    this.clearRecoveryTimer();
    // The fallback has already unmounted the children. Clearing the report
    // constructs a fresh tree while the window recovery provider stays alive.
    this.setState({ report: undefined, recovering: false });
  };

  private retryManually = (): void => {
    if (this.state.report) {
      reportRendererError({
        ...this.state.report,
        timestamp: new Date().toISOString(),
        recovery: {
          action: "manual-remount",
          attempt: this.automaticAttempts,
          limit: MAX_AUTOMATIC_RENDERER_RECOVERIES,
        },
      });
    }
    // Operator retries never replenish the automatic budget.
    this.remount();
  };

  override render() {
    if (this.state.report) {
      return (
        <main className="renderer-error-boundary" role="alert">
          <p className="eyebrow">PwrAgent</p>
          <h1>Renderer error</h1>
          <p>
            {this.state.recovering
              ? "Restoring this window…"
              : "Automatic recovery stopped after repeated UI errors. You can try again."}
          </p>
          <p>Running agents and connections continue. Error details were logged.</p>
          <button className="button button--primary" onClick={this.retryManually}>
            Try again
          </button>
          <pre>{this.state.report.message}</pre>
        </main>
      );
    }

    return this.props.children;
  }
}
