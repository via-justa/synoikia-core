import { ErrorCodes, joinApiPath, PendingRequests, PluginError, singleFlight } from '@synoikia/plugin-sdk';
import WebSocket from 'ws';

/** JSON-RPC 2.0 over one WebSocket: lazy connect (auth on upgrade), reconnect after a drop, pending calls
 * fail on close; errors name the method, never params or credentials. */

export interface RpcConnection {
  baseUrl: string;
  path: string;
  verifyTls: boolean;
  headers: () => Record<string, string>;
  timeoutMs: number;
}

interface RpcError {
  code?: number;
  message?: string;
}

export class RpcClient {
  private ws?: WebSocket;
  private readonly pending = new PendingRequests();
  private readonly connect = singleFlight(() => this.open());

  constructor(private readonly conn: RpcConnection) {
    joinApiPath(conn.baseUrl, conn.path, { websocket: true }); // validate early
  }

  async call(method: string, params: unknown, timeoutMs = this.conn.timeoutMs): Promise<unknown> {
    const ws = this.ws?.readyState === WebSocket.OPEN ? this.ws : await this.connect();
    const { id, promise } = this.pending.start(method, timeoutMs);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }), (err) => {
      if (err) this.pending.fail(id, new PluginError(ErrorCodes.UpstreamError, `${method}: could not send`));
    });
    return promise;
  }

  close(): void {
    this.ws?.terminate();
    this.ws = undefined;
    this.pending.failAll(new PluginError(ErrorCodes.UpstreamError, 'Connection closed'));
  }

  private open(): Promise<WebSocket> {
    const url = joinApiPath(this.conn.baseUrl, this.conn.path, { websocket: true });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: this.conn.headers(),
        rejectUnauthorized: this.conn.verifyTls,
        handshakeTimeout: this.conn.timeoutMs,
      });
      ws.once('open', () => {
        this.ws = ws;
        resolve(ws);
      });
      ws.once('unexpected-response', (_req, res) => {
        const denied = res.statusCode === 401 || res.statusCode === 403;
        reject(
          new PluginError(
            denied ? ErrorCodes.UpstreamDenied : ErrorCodes.UpstreamError,
            denied ? 'The upstream denied the connection: the credentials were rejected' : `The upstream refused the connection (HTTP ${res.statusCode})`,
          ),
        );
        ws.terminate();
      });
      ws.once('error', () =>
        reject(new PluginError(ErrorCodes.UpstreamError, `The upstream is unreachable at ${new URL(url).host}`)),
      );
      ws.on('close', () => {
        if (this.ws === ws) this.ws = undefined;
        this.pending.failAll(new PluginError(ErrorCodes.UpstreamError, 'The upstream closed the connection'));
      });
      ws.on('message', (data) => {
        let msg: { id?: unknown; result?: unknown; error?: RpcError };
        try {
          msg = JSON.parse(data.toString()) as typeof msg;
        } catch {
          return;
        }
        const p = this.pending.take(msg.id);
        if (!p) return;
        if (!msg.error) return p.resolve(msg.result ?? null);
        const code =
          msg.error.code === -32601
            ? ErrorCodes.UnknownOperation
            : msg.error.code === -32602
              ? ErrorCodes.InvalidParams
              : ErrorCodes.UpstreamError;
        p.reject(new PluginError(code, `${p.label}: ${msg.error.message ?? 'error'}`));
      });
    });
  }
}
