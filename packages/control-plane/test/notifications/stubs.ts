import { createServer as createTcpServer, type Socket } from 'node:net';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** A minimal in-process SMTP receiver (plaintext, `secure:'none'`) — enough for
 * Nodemailer to complete EHLO→MAIL→RCPT→DATA→QUIT. It records accepted messages
 * so the e2e can assert a delivery landed. `rejectRcpt` makes it 550 every
 * recipient (a reachable-but-refusing relay). */
export interface SmtpStub {
  readonly port: number;
  readonly messages: Array<{ from: string; to: string[]; data: string }>;
  close(): Promise<void>;
}

export async function startSmtpStub(opts: { rejectRcpt?: boolean } = {}): Promise<SmtpStub> {
  const messages: SmtpStub['messages'] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    handleSmtpSession(sock, messages, opts);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function handleSmtpSession(
  sock: Socket,
  messages: SmtpStub['messages'],
  opts: { rejectRcpt?: boolean },
): void {
  let buffer = '';
  let inData = false;
  let dataBuf = '';
  let from = '';
  let to: string[] = [];
  sock.on('error', () => {});
  sock.write('220 stub ESMTP\r\n');
  sock.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    for (;;) {
      if (inData) {
        const term = buffer.indexOf('\r\n.\r\n');
        if (term === -1) return;
        dataBuf += buffer.slice(0, term);
        buffer = buffer.slice(term + 5);
        inData = false;
        messages.push({ from, to: [...to], data: dataBuf });
        dataBuf = '';
        from = '';
        to = [];
        sock.write('250 2.0.0 Ok queued\r\n');
        continue;
      }
      const nl = buffer.indexOf('\r\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        sock.write('250-stub\r\n250 OK\r\n');
      } else if (upper.startsWith('MAIL FROM')) {
        from = line;
        sock.write('250 2.1.0 Ok\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        if (opts.rejectRcpt) {
          sock.write('550 5.1.1 no such user\r\n');
        } else {
          to.push(line);
          sock.write('250 2.1.5 Ok\r\n');
        }
      } else if (upper.startsWith('DATA')) {
        inData = true;
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (upper.startsWith('QUIT')) {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
        return;
      } else if (upper.startsWith('RSET')) {
        from = '';
        to = [];
        sock.write('250 2.0.0 Ok\r\n');
      } else {
        sock.write('250 2.0.0 Ok\r\n'); // NOOP / lenient
      }
    }
  });
}

/** A stub for `APPRISE_API_URL` — accepts `POST /notify`, records the JSON body,
 * and replies 200 (or 500 when `fail` is set) so the e2e can assert the delivery
 * reached the sidecar without a real Apprise container. */
export interface AppriseStub {
  readonly port: number;
  readonly url: string;
  readonly requests: Array<Record<string, unknown>>;
  fail: boolean;
  close(): Promise<void>;
}

export async function startAppriseStub(): Promise<AppriseStub> {
  const requests: AppriseStub['requests'] = [];
  const state = { fail: false };
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && (req.url ?? '').startsWith('/notify')) {
        try {
          requests.push(JSON.parse(body || '{}'));
        } catch {
          requests.push({ raw: body });
        }
        res.statusCode = state.fail ? 500 : 200;
        res.end(state.fail ? 'fail' : 'ok');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    get fail() {
      return state.fail;
    },
    set fail(v: boolean) {
      state.fail = v;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections(); // drop undici keep-alive sockets so close() can't hang
        server.close(() => resolve());
      }),
  };
}

/** Poll a predicate until true or the deadline elapses (async delivery waits). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
