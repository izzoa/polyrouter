/** Vitest setup: minimal headless (happy-dom) shims so the uPlot `<Chart>` wrapper
 * smoke-mounts without swallowing real constructor errors in production. */
import { beforeEach } from 'vitest';

// The URL is real store input now (add-dashboard-hash-routing): the router reads
// the fragment on mount to select the initial page. Tests share one global
// `location`, so a page fragment written by one test would otherwise decide the
// starting page of the next. Reset to a clean root before each test — the
// equivalent of a fresh browser visit, which is what every test assumes.
beforeEach(() => {
  globalThis.history.replaceState(null, '', '/');
});

// happy-dom has no canvas 2D context; uPlot only needs one that doesn't throw for
// a smoke mount. A Proxy returns a no-op for any method and swallows property
// gets/sets; measureText returns a zero-width metric.
function makeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    canvas,
    measureText: () => ({ width: 0 }),
    getContextAttributes: () => ({}),
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      return () => undefined;
    },
    set() {
      return true;
    },
  };
  return new Proxy(target, handler) as unknown as CanvasRenderingContext2D;
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value(this: HTMLCanvasElement): CanvasRenderingContext2D {
    return makeContext(this);
  },
});

// uPlot builds line/area geometry with Path2D during its (async) draw; happy-dom
// lacks it. A no-op stub is enough — the shimmed 2D context ignores the path.
if (typeof globalThis.Path2D === 'undefined') {
  class Path2DStub {
    addPath(): void {
      /* no-op */
    }
    moveTo(): void {
      /* no-op */
    }
    lineTo(): void {
      /* no-op */
    }
    arc(): void {
      /* no-op */
    }
    arcTo(): void {
      /* no-op */
    }
    bezierCurveTo(): void {
      /* no-op */
    }
    quadraticCurveTo(): void {
      /* no-op */
    }
    closePath(): void {
      /* no-op */
    }
    rect(): void {
      /* no-op */
    }
    ellipse(): void {
      /* no-op */
    }
  }
  globalThis.Path2D = Path2DStub as unknown as typeof Path2D;
}

// <Chart> observes its container; provide a no-op if the environment lacks it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// uPlot reads devicePixelRatio at construction.
if (typeof globalThis.devicePixelRatio === 'undefined') {
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1 });
}
