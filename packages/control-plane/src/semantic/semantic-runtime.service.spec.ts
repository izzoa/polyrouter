import { stubEmbedder } from '@polyrouter/data-plane';
import { SemanticLoadError, type SemanticLoader } from './onnx-loader';
import { SemanticRuntimeService } from './semantic-runtime.service';
import type { SemanticConfig } from './semantic.config';

const cfg = (modelPath?: string): SemanticConfig => ({
  modelPath,
  timeoutMs: 50,
  maxInputChars: 2000,
  concurrency: 2,
    highThreshold: 0.15,
    lowThreshold: 0.15,
});

const stubLoader =
  (calls: { count: number }): SemanticLoader =>
  (c) => {
    calls.count += 1;
    void c;
    return Promise.resolve({
      embedder: Object.assign(stubEmbedder(8), { saturated: false }),
      warmupMs: 3,
    });
  };

describe('SemanticRuntimeService (add-semantic-embedder D5)', () => {
  it('unset path: no-op hook, loader never called, unavailable', async () => {
    const calls = { count: 0 };
    const svc = new SemanticRuntimeService(cfg(undefined), stubLoader(calls));
    await svc.onApplicationBootstrap();
    expect(calls.count).toBe(0);
    expect(svc.available).toBe(false);
    expect(svc.embedder).toBeNull();
    expect(svc.saturated).toBe(false);
  });

  it('valid path: loads, warms, capability true, embedder exposed', async () => {
    const calls = { count: 0 };
    const svc = new SemanticRuntimeService(cfg('/models/x'), stubLoader(calls));
    await svc.onApplicationBootstrap();
    expect(calls.count).toBe(1);
    expect(svc.available).toBe(true);
    expect(svc.embedder?.dims).toBe(8);
  });

  it('broken bundle: bootstrap THROWS naming the variable + basename + reason, never the full path', async () => {
    const loader: SemanticLoader = () =>
      Promise.reject(new SemanticLoadError('model.onnx', 'session create failed: bad magic'));
    const svc = new SemanticRuntimeService(cfg('/secret/operator/dir/models/x'), loader);
    let message = '';
    try {
      await svc.onApplicationBootstrap();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('SEMANTIC_MODEL_PATH');
    expect(message).toContain('model.onnx');
    expect(message).toContain('bad magic');
    expect(message).not.toContain('/secret/operator/dir');
    expect(svc.available).toBe(false);
  });
});
