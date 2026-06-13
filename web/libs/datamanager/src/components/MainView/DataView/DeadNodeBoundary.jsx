import React from "react";

// cars-mods: markers of mobx-state-tree "dead node" errors. Two distinct MST operations
// throw when applied to a DETACHED node:
//   - property read/write  → "no longer part of a state tree"
//   - getRoot / getParent  → "Failed to find the parent of … [dead] at depth N"
const MST_LIVENESS_MARKERS = ["no longer part of a state tree", "Failed to find the parent"];

function isMstLivenessError(error) {
  const msg = String(error?.message ?? error ?? "");
  return MST_LIVENESS_MARKERS.some((m) => msg.includes(m));
}

/**
 * cars-mods: recover from transient mobx-state-tree "dead node" errors instead of
 * white-screening the whole app.
 *
 * The virtualized grid/table keeps observer cells mounted while the task list is
 * REPLACED on every fetch (filter/sort reload via `self.list = [...]`, and the
 * splice in setList() on lazy pagination). The old TaskModel nodes get detached;
 * any property read OR getRoot/getParent on a detached node throws. React would
 * propagate that to the app-level boundary → full white-screen crash (what an
 * annotator saw: "[mobx-state-tree] Failed to find the parent of TaskModel …").
 *
 * Individual cells guard with isAlive(), but this is the safety net: it swallows
 * ONLY MST-liveness errors and re-renders on the next animation frame, by which
 * point the dataStore list has settled with live nodes (the dead node is no longer
 * in `data`, so no cell references it anymore). Real errors are re-thrown so they
 * still surface. `resetKey` (a value that changes when the list settles) clears the
 * retry budget; a cap prevents an infinite blank↔render loop if something stays broken.
 */
export class DeadNodeBoundary extends React.Component {
  state = { failed: false, retries: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (!isMstLivenessError(error)) throw error; // let real crashes propagate
    if (this.state.retries >= 8) return; // stop auto-recovery; render fallback instead of looping
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => this.setState((s) => ({ failed: false, retries: s.retries + 1 })));
  }

  componentDidUpdate(prevProps) {
    // A new data identity = the churn settled → restore the retry budget so a later
    // independent reload still gets its full set of recovery attempts.
    if (prevProps.resetKey !== this.props.resetKey && (this.state.failed || this.state.retries)) {
      this.setState({ failed: false, retries: 0 });
    }
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
