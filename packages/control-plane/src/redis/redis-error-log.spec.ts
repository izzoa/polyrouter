import { EventEmitter } from 'node:events';
import { installRedisErrorLog } from './redis.module';

// A-43: the Redis error listener contains an outage to one log line and never logs
// `err.message` (which can carry the endpoint/credentials/server text — invariant 8).
describe('installRedisErrorLog (A-43)', () => {
  function harness(): { emitter: EventEmitter; lines: string[] } {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    installRedisErrorLog(emitter, { error: (m) => lines.push(m) });
    return { emitter, lines };
  }

  it('logs once per outage and never echoes the error message', () => {
    const { emitter, lines } = harness();
    const hostile = Object.assign(new Error('connect ECONNREFUSED redis://user:s3cr3t@10.0.0.9:6379'), {
      code: 'ECONNREFUSED',
    });
    emitter.emit('error', hostile);
    emitter.emit('error', hostile); // a flood during the same outage...
    emitter.emit('error', hostile);
    expect(lines).toHaveLength(1); // ...is latched to a single line
    expect(lines[0]).toContain('ECONNREFUSED'); // the safe syscall code
    expect(lines[0]).not.toContain('s3cr3t'); // never the credential / URL
    expect(lines[0]).not.toContain('10.0.0.9');
  });

  it('re-arms after a successful reconnect', () => {
    const { emitter, lines } = harness();
    emitter.emit('error', Object.assign(new Error('down'), { code: 'ETIMEDOUT' }));
    emitter.emit('ready'); // reconnected
    emitter.emit('error', Object.assign(new Error('down again'), { code: 'ECONNRESET' }));
    expect(lines).toHaveLength(2); // one per distinct outage
    expect(lines[1]).toContain('ECONNRESET');
  });

  it('falls back to the error class name when there is no syscall code', () => {
    const { emitter, lines } = harness();
    emitter.emit('error', new TypeError('boom with secret sk-xyz'));
    expect(lines[0]).toContain('TypeError');
    expect(lines[0]).not.toContain('sk-xyz');
  });
});
