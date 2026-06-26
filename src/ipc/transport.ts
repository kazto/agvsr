/**
 * Local IPC transport (D18). Newline-delimited JSON frames over `node:net`,
 * which gives one code path for POSIX unix sockets and Windows named pipes
 * (the endpoint is just a `path`).
 */
import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { Frame, Request, Response } from "../protocol.ts";

/** Split a byte stream into newline-delimited JSON objects. */
function frameReader(onFrame: (obj: unknown) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line));
      } catch {
        /* ignore malformed frame */
      }
    }
  };
}

const encode = (frame: Frame): string => JSON.stringify(frame) + "\n";

export type RequestHandler = (req: Request) => Promise<Response> | Response;

export interface IpcServer {
  readonly endpoint: string;
  /** Stop listening and forcibly drop any open client connections. */
  close(): Promise<void>;
}

/** Start a daemon-side IPC server. */
export function serve(endpoint: string, handler: RequestHandler): Promise<IpcServer> {
  // Clear a stale POSIX socket file from a previous run (named pipes self-clean).
  if (process.platform !== "win32" && existsSync(endpoint)) {
    try {
      unlinkSync(endpoint);
    } catch {
      /* fall through; listen will surface a real conflict */
    }
  }

  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    const read = frameReader(async (obj) => {
      const req = obj as Request;
      if (req?.type !== "request") return;
      try {
        const res = await handler(req);
        sock.write(encode(res));
      } catch (err) {
        sock.write(
          encode({
            id: req.id,
            type: "response",
            ok: false,
            error: { code: "internal", message: (err as Error).message },
          }),
        );
      }
    });
    sock.on("data", read);
    sock.on("error", () => sock.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve({
        endpoint,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            server.close(() => res());
          }),
      });
    });
  });
}

export class DaemonNotRunningError extends Error {
  constructor(endpoint: string) {
    super(`agvsr daemon is not running (no IPC endpoint at ${endpoint}). Start it with: agvsr daemon`);
    this.name = "DaemonNotRunningError";
  }
}

/** A client connection that can issue many request/response pairs. */
export class Client {
  private seq = 0;
  private pending = new Map<string, (res: Response) => void>();

  private constructor(private sock: net.Socket) {
    sock.on(
      "data",
      frameReader((obj) => {
        const res = obj as Response;
        if (res?.type !== "response") return;
        this.pending.get(res.id)?.(res);
        this.pending.delete(res.id);
      }),
    );
  }

  static connect(endpoint: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(endpoint);
      sock.once("connect", () => resolve(new Client(sock)));
      sock.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          reject(new DaemonNotRunningError(endpoint));
        } else {
          reject(err);
        }
      });
    });
  }

  request<T = unknown>(method: Request["method"], params?: unknown): Promise<Response<T>> {
    const id = `c${++this.seq}`;
    const frame = { id, type: "request", method, params } as Request;
    return new Promise<Response<T>>((resolve) => {
      this.pending.set(id, resolve as (res: Response) => void);
      this.sock.write(encode(frame));
    });
  }

  close(): void {
    this.sock.end();
  }
}
