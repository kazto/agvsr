/// <reference lib="dom" />
type SessionResponse =
  | { authenticated: false }
  | {
      authenticated: true;
      session: { created_at: string; last_seen_at: string };
      csrfToken: string;
    };

type JobSummary = {
  job: {
    id: string;
    goal: string;
    status: string;
    cwd: string;
    branch: string | null;
    worktree: string | null;
    created_at: string;
    updated_at: string;
  };
  runtime: {
    in_flight: boolean;
    active_roles: string[];
    idle_ms: number | null;
  };
  display_state: "in_flight" | "idle" | "possibly_stalled" | "terminal";
};

type JobDetail = JobSummary & {
  messages: Array<{
    id: string;
    from_role: string;
    to_role: string;
    kind: string;
    body: string;
    created_at: string;
    refs: string | null;
  }>;
};

const POLL_MS = 2000;

export function startPolling(fn: () => void | Promise<void>, ms = POLL_MS): () => void {
  void fn();
  const timer = setInterval(() => {
    void fn();
  }, ms);
  return () => clearInterval(timer);
}

export function classifyJob(job: JobSummary): string {
  if (job.display_state !== "terminal") return job.display_state;
  return job.job.status;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function renderMessage(container: HTMLElement, message: JobDetail["messages"][number]): void {
  const item = document.createElement("article");
  item.className = "message";
  item.append(
    textEl("div", `${message.kind} ${message.from_role} -> ${message.to_role}`, "message__meta"),
    textEl("pre", message.body, "message__body"),
  );
  if (message.refs) {
    item.append(textEl("div", `refs ${message.refs}`, "message__refs"));
  }
  container.append(item);
}

function renderJobDetail(container: HTMLElement, detail: JobDetail): void {
  const section = document.createElement("section");
  section.className = "detail";
  section.append(
    textEl("h2", detail.job.goal),
    textEl("div", `job ${detail.job.id} · ${detail.job.status} · ${detail.display_state}`, "muted"),
    textEl(
      "div",
      detail.runtime.in_flight
        ? `in flight: ${detail.runtime.active_roles.join(", ")}`
        : detail.runtime.idle_ms == null
          ? "idle"
          : `idle ${Math.round(detail.runtime.idle_ms / 1000)}s`,
      "muted",
    ),
  );
  const messages = document.createElement("div");
  messages.className = "messages";
  for (const message of detail.messages) renderMessage(messages, message);
  section.append(messages);
  container.replaceChildren(section);
}

function renderJobs(
  container: HTMLElement,
  jobs: JobSummary[],
  onSelect: (id: string) => void,
): void {
  const list = document.createElement("div");
  list.className = "job-list";
  for (const job of jobs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "job";
    row.append(
      textEl("div", job.job.goal, "job__goal"),
      textEl("div", `${job.job.status} · ${classifyJob(job)}`, "job__meta"),
    );
    row.addEventListener("click", () => onSelect(job.job.id));
    list.append(row);
  }
  container.replaceChildren(list);
}

export function mountApp(root: HTMLElement): void {
  let csrfToken = "";
  let currentJobId: string | null = null;
  const shell = document.createElement("div");
  shell.className = "shell";
  const banner = document.createElement("header");
  banner.className = "banner";
  const content = document.createElement("main");
  content.className = "content";
  const sidebar = document.createElement("section");
  sidebar.className = "sidebar";
  const detail = document.createElement("section");
  detail.className = "detail-pane";
  content.append(sidebar, detail);
  shell.append(banner, content);
  root.replaceChildren(shell);

  const loginForm = document.createElement("form");
  loginForm.className = "login";
  const tokenInput = document.createElement("input");
  tokenInput.name = "token";
  tokenInput.type = "password";
  tokenInput.autocomplete = "one-time-code";
  tokenInput.placeholder = "Startup token";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Log in";
  loginForm.append(
    textEl("h1", "agvsr web"),
    textEl("p", "Enter the startup token shown by the gateway process."),
    tokenInput,
    submit,
  );

  async function api<T>(input: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
    headers.set("Content-Type", "application/json");
    const res = await fetch(input, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as T;
  }

  async function refreshSession(): Promise<void> {
    const session = (await api("/api/session", { headers: {} })) as SessionResponse;
    if (!session.authenticated) {
      csrfToken = "";
      banner.replaceChildren(
        textEl("div", "agvsr web", "brand"),
        textEl("div", "read-only monitoring", "muted"),
      );
      content.replaceChildren(loginForm);
      return;
    }
    csrfToken = session.csrfToken;
    banner.replaceChildren(
      textEl("div", "agvsr web", "brand"),
      textEl("div", "authenticated", "muted"),
    );
    content.replaceChildren(sidebar, detail);
  }

  async function refreshJobs(): Promise<void> {
    const res = (await api("/api/jobs", { headers: {} })) as { jobs: JobSummary[] };
    renderJobs(sidebar, res.jobs, (id) => {
      currentJobId = id;
      void refreshDetail(id);
    });
    if (currentJobId) {
      const exists = res.jobs.some((job) => job.job.id === currentJobId);
      if (exists) void refreshDetail(currentJobId);
    }
  }

  async function refreshDetail(id: string): Promise<void> {
    const res = (await api(`/api/jobs/${encodeURIComponent(id)}`, { headers: {} })) as JobDetail;
    renderJobDetail(detail, res);
  }

  loginForm.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) return;
    csrfToken = token;
    try {
      await api("/api/session/login", {
        method: "POST",
        headers: { "X-CSRF-Token": token },
        body: JSON.stringify({ token }),
      });
      tokenInput.value = "";
      await refreshSession();
      await refreshJobs();
    } catch {
      csrfToken = "";
      banner.replaceChildren(textEl("div", "login failed", "error"));
    }
  });

  startPolling(async () => {
    await refreshSession();
    if (csrfToken) {
      await refreshJobs();
    }
  }, POLL_MS);
}

if (typeof document !== "undefined") {
  const root = document.getElementById("app");
  if (root) mountApp(root);
}
