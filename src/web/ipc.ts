import { Client } from "../ipc/transport.ts";
import type { Job, JobRuntime, Message, Request } from "../protocol.ts";

export interface JobView {
  job: Job;
  runtime: JobRuntime;
  display_state: "in_flight" | "idle" | "possibly_stalled" | "terminal";
}

export interface JobDetailView extends JobView {
  messages: Message[];
}

export class WebDaemonError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebDaemonError";
  }
}

export class WebDaemonClient {
  private constructor(private client: Client) {}

  static async connect(endpoint: string): Promise<WebDaemonClient> {
    return new WebDaemonClient(await Client.connect(endpoint));
  }

  close(): void {
    this.client.close();
  }

  private async request<T>(method: Request["method"], params?: unknown): Promise<T> {
    const res = await this.client.request<T>(method, params);
    if (!res.ok) throw new WebDaemonError(res.error.code, res.error.message);
    return res.result;
  }

  async listJobs(): Promise<Job[]> {
    return (await this.request<{ jobs: Job[] }>("job.list")).jobs;
  }

  async getJob(id: string): Promise<{ job: Job; runtime: JobRuntime }> {
    return await this.request<{ job: Job; runtime: JobRuntime }>("job.get", { id });
  }

  async listMessages(jobId: string): Promise<Message[]> {
    return (
      await this.request<{ messages: Message[] }>("msg.list", {
        job_id: jobId,
      })
    ).messages;
  }

  async createJob(goal: string, cwd: string, id?: string): Promise<{ job: Job }> {
    return await this.request<{ job: Job }>("job.create", { goal, cwd, id });
  }

  async tellJob(jobId: string, body: string): Promise<{ queued: true; message: Message }> {
    return await this.request<{ queued: true; message: Message }>("job.tell", {
      job_id: jobId,
      body,
    });
  }

  async stopJob(jobId: string): Promise<{ stopped: true }> {
    return await this.request<{ stopped: true }>("job.stop", { job_id: jobId });
  }

  async killJob(jobId: string): Promise<{ killed: true }> {
    return await this.request<{ killed: true }>("job.kill", { job_id: jobId });
  }
}
