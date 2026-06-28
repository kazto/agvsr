import { Client } from "../ipc/transport.ts";
import type { Job, Message, JobRuntime } from "../protocol.ts";

export interface JobView {
  job: Job;
  runtime: JobRuntime;
  display_state: "in_flight" | "idle" | "possibly_stalled" | "terminal";
}

export interface JobDetailView extends JobView {
  messages: Message[];
}

export class WebDaemonClient {
  private constructor(private client: Client) {}

  static async connect(endpoint: string): Promise<WebDaemonClient> {
    return new WebDaemonClient(await Client.connect(endpoint));
  }

  close(): void {
    this.client.close();
  }

  async listJobs(): Promise<Job[]> {
    const res = await this.client.request<{ jobs: Job[] }>("job.list");
    if (!res.ok) throw new Error(res.error.message);
    return res.result.jobs;
  }

  async getJob(id: string): Promise<{ job: Job; runtime: JobRuntime }> {
    const res = await this.client.request<{ job: Job; runtime: JobRuntime }>("job.get", { id });
    if (!res.ok) throw new Error(res.error.message);
    return res.result;
  }

  async listMessages(jobId: string): Promise<Message[]> {
    const res = await this.client.request<{ messages: Message[] }>("msg.list", {
      job_id: jobId,
    });
    if (!res.ok) throw new Error(res.error.message);
    return res.result.messages;
  }
}
