import type { ServerWebSocket, WebSocketHandler } from "bun";
import { Client } from "../ipc/transport.ts";
import type { Message, PushFrame } from "../protocol.ts";

export type StreamSocketData = { kind: "job"; jobId: string } | { kind: "jobs" };

type StreamSocket = ServerWebSocket<StreamSocketData>;

interface SocketState {
  jobId: string;
  ready: boolean;
  closed: boolean;
  seenIds: Set<string>;
  queue: Array<Extract<PushFrame, { event: "msg.new" }>>;
}

export interface WebStreamBridge {
  websocket: WebSocketHandler<StreamSocketData>;
  close(): Promise<void>;
}

function frameForMessage(message: Message): Extract<PushFrame, { event: "msg.new" }> {
  return { type: "push", event: "msg.new", data: message };
}

export async function createWebStreamBridge(daemonEndpoint: string): Promise<WebStreamBridge> {
  const client = await Client.connect(daemonEndpoint);
  const subscribers = new Map<string, Set<StreamSocket>>();
  const watchedJobs = new Set<string>();
  const watchPromises = new Map<string, Promise<void>>();
  const states = new Map<StreamSocket, SocketState>();
  const jobsSubscribers = new Set<StreamSocket>();

  // Subscribe to global job lifecycle push events once at startup.
  void client.request("job.watch");

  const cleanup = (ws: StreamSocket): void => {
    const state = states.get(ws);
    if (state) {
      state.closed = true;
      state.queue.length = 0;
      states.delete(ws);
    }
    if (ws.data.kind !== "job") return;
    const jobId = ws.data.jobId;
    const set = subscribers.get(jobId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) subscribers.delete(jobId);
  };

  const sendFrame = (ws: StreamSocket, frame: PushFrame): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.sendText(JSON.stringify(frame));
  };

  const ensureWatched = (jobId: string): Promise<void> => {
    if (watchedJobs.has(jobId)) return Promise.resolve();
    const existing = watchPromises.get(jobId);
    if (existing) return existing;
    const promise = (async () => {
      const res = await client.request<{ watching: boolean }>("msg.watch", { job_id: jobId });
      if (!res.ok) throw new Error(res.error.message);
      watchedJobs.add(jobId);
    })().finally(() => {
      watchPromises.delete(jobId);
    });
    watchPromises.set(jobId, promise);
    return promise;
  };

  const deliverPush = (frame: Extract<PushFrame, { event: "msg.new" }>): void => {
    const set = subscribers.get(frame.data.job_id);
    if (!set || set.size === 0) return;
    for (const ws of set) {
      const state = states.get(ws);
      if (!state || state.closed) continue;
      if (state.seenIds.has(frame.data.id)) continue;
      state.seenIds.add(frame.data.id);
      if (state.ready) {
        sendFrame(ws, frame);
        continue;
      }
      state.queue.push(frame);
    }
  };

  const deliverJobUpdate = (frame: Extract<PushFrame, { event: "job.update" }>): void => {
    for (const ws of jobsSubscribers) {
      if (ws.readyState !== WebSocket.OPEN) {
        jobsSubscribers.delete(ws);
        continue;
      }
      ws.sendText(JSON.stringify(frame));
    }
  };

  client.onPush = (frame) => {
    if (frame.event === "msg.new") {
      deliverPush(frame);
    } else if (frame.event === "job.update") {
      deliverJobUpdate(frame);
    }
  };

  const primeSocket = async (ws: StreamSocket): Promise<void> => {
    if (ws.data.kind !== "job") return;
    const jobId = ws.data.jobId;
    const state = states.get(ws);
    if (!state) return;
    try {
      await ensureWatched(jobId);
      if (state.closed || ws.readyState !== WebSocket.OPEN) return;
      const res = await client.request<{ messages: Message[] }>("msg.list", {
        job_id: jobId,
      });
      if (!res.ok) throw new Error(res.error.message);
      if (state.closed || ws.readyState !== WebSocket.OPEN) return;
      for (const message of res.result.messages) {
        if (state.seenIds.has(message.id)) continue;
        state.seenIds.add(message.id);
        sendFrame(ws, frameForMessage(message));
      }
      if (state.closed || ws.readyState !== WebSocket.OPEN) return;
      state.ready = true;
      const queued = state.queue;
      state.queue = [];
      for (const frame of queued) {
        sendFrame(ws, frame);
      }
    } catch {
      if (!state.closed) ws.close(1011, "stream unavailable");
    }
  };

  const websocket: WebSocketHandler<StreamSocketData> = {
    message() {
      /* read-only stream; clients must not send messages */
    },
    open(ws) {
      if (ws.data.kind === "jobs") {
        jobsSubscribers.add(ws);
        return;
      }
      const jobId = ws.data.jobId;
      let set = subscribers.get(jobId);
      if (!set) {
        set = new Set();
        subscribers.set(jobId, set);
      }
      set.add(ws);
      states.set(ws, {
        jobId,
        ready: false,
        closed: false,
        seenIds: new Set(),
        queue: [],
      });
      void primeSocket(ws);
    },
    close(ws) {
      if (ws.data.kind === "jobs") {
        jobsSubscribers.delete(ws);
        return;
      }
      cleanup(ws);
    },
  };

  return {
    websocket,
    async close() {
      client.close();
      subscribers.clear();
      watchedJobs.clear();
      watchPromises.clear();
      states.clear();
      jobsSubscribers.clear();
    },
  };
}
