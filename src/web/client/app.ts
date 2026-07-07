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
    job_id: string;
    from_role: string;
    to_role: string;
    kind: string;
    body: string;
    created_at: string;
    refs: string | null;
  }>;
};

type StreamFrame = {
  event: "msg.new";
  data: JobDetail["messages"][number];
};

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const POLL_MS = 2000;
const STREAM_RECONNECT_MIN_MS = 500;
const STREAM_RECONNECT_MAX_MS = 8000;

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

function buttonEl(
  text: string,
  className?: string,
  type: "button" | "submit" = "button",
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = type;
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function inputEl(
  type: string,
  name: string,
  placeholder: string,
  className?: string,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.name = name;
  el.placeholder = placeholder;
  if (className) el.className = className;
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

interface DetailState {
  jobId: string;
  messagesEl: HTMLElement;
  seenMessageIds: Set<string>;
}

interface DetailActions {
  tell(jobId: string, message: string): Promise<void>;
  stop(jobId: string): Promise<void>;
  kill(jobId: string): Promise<void>;
  reportError(message: string): void;
}

function renderJobDetail(
  container: HTMLElement,
  detail: JobDetail,
  actions: DetailActions,
): DetailState {
  const section = document.createElement("section");
  section.className = "detail";
  const tellForm = document.createElement("form");
  tellForm.className = "action-form";
  const tellField = document.createElement("textarea");
  tellField.name = "message";
  tellField.placeholder = "Tell the supervisor something";
  tellField.rows = 4;
  const tellButton = buttonEl("Send tell", "action-form__submit", "submit");
  const stopButton = buttonEl("Stop job", "danger-button");
  const killButton = buttonEl("Kill job", "kill-button");
  const actionsRow = document.createElement("div");
  actionsRow.className = "detail__actions";
  actionsRow.append(stopButton, killButton);
  tellForm.append(tellField, actionsRow, tellButton);
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
    tellForm,
  );
  const messages = document.createElement("div");
  messages.className = "messages";
  const seenMessageIds = new Set<string>();
  for (const message of detail.messages) renderMessage(messages, message);
  for (const message of detail.messages) seenMessageIds.add(message.id);
  section.append(messages);
  container.replaceChildren(section);
  const running = detail.job.status === "running";
  tellField.disabled = !running;
  tellButton.disabled = !running;
  stopButton.disabled = !running;
  killButton.disabled = !running;
  tellForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = tellField.value.trim();
    if (!message) return;
    try {
      await actions.tell(detail.job.id, message);
      tellField.value = "";
    } catch (err) {
      actions.reportError(err instanceof ApiError ? err.message : "tell failed");
    }
  });
  stopButton.addEventListener("click", async () => {
    if (!confirm(`Stop job ${detail.job.id}?`)) return;
    try {
      await actions.stop(detail.job.id);
    } catch (err) {
      actions.reportError(err instanceof ApiError ? err.message : "stop failed");
    }
  });
  killButton.addEventListener("click", async () => {
    if (!confirm(`Kill job ${detail.job.id}?`)) return;
    try {
      await actions.kill(detail.job.id);
    } catch (err) {
      actions.reportError(err instanceof ApiError ? err.message : "kill failed");
    }
  });
  return {
    jobId: detail.job.id,
    messagesEl: messages,
    seenMessageIds,
  };
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
  let detailState: DetailState | null = null;
  let streamSocket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectDelayMs = STREAM_RECONNECT_MIN_MS;
  let pushRegistration: ServiceWorkerRegistration | null = null;
  const shell = document.createElement("div");
  shell.className = "shell";
  const banner = document.createElement("header");
  banner.className = "banner";
  const bannerState = document.createElement("div");
  bannerState.className = "banner__state";
  const bannerStatus = document.createElement("div");
  bannerStatus.className = "banner__status";
  const pushToggle = document.createElement("button");
  pushToggle.type = "button";
  pushToggle.className = "push-toggle push-toggle--hidden";
  pushToggle.textContent = "Enable notifications";
  bannerState.append(bannerStatus, pushToggle);
  banner.append(textEl("div", "agvsr web", "brand"), bannerState);
  const content = document.createElement("main");
  content.className = "content";
  const sidebar = document.createElement("section");
  sidebar.className = "sidebar";
  const sidebarInner = document.createElement("div");
  sidebarInner.className = "sidebar__inner";
  const createForm = document.createElement("form");
  createForm.className = "create-form";
  const goalInput = inputEl("text", "goal", "New job goal");
  const cwdInput = inputEl("text", "cwd", "cwd");
  const idInput = inputEl("text", "id", "optional id");
  const createButton = buttonEl("Create job", "create-form__submit", "submit");
  createForm.append(
    textEl("h2", "Create job", "panel-title"),
    goalInput,
    cwdInput,
    idInput,
    createButton,
  );
  const jobsHost = document.createElement("div");
  jobsHost.className = "sidebar__jobs";
  sidebarInner.append(createForm, jobsHost);
  sidebar.append(sidebarInner);
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
    if (!res.ok) {
      throw new ApiError(await readErrorMessage(res), res.status);
    }
    return (await res.json()) as T;
  }

  async function readErrorMessage(res: Response): Promise<string> {
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
      if (typeof parsed.error === "string") return parsed.error;
      if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
        return parsed.error.message;
      }
    } catch {
      /* fall through */
    }
    return raw || `request failed (${res.status})`;
  }

  function setBannerStatus(text: string, className = "muted"): void {
    bannerStatus.className = className;
    bannerStatus.textContent = text;
  }

  function showError(message: string): void {
    setBannerStatus(message, "error");
  }

  async function refreshSession(): Promise<void> {
    const session = (await api("/api/session", { headers: {} })) as SessionResponse;
    if (!session.authenticated) {
      csrfToken = "";
      currentJobId = null;
      detailState = null;
      closeStream();
      setBannerStatus("read-only monitoring");
      content.replaceChildren(loginForm);
      return;
    }
    csrfToken = session.csrfToken;
    setBannerStatus("authenticated");
    content.replaceChildren(sidebar, detail);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeStream(): void {
    clearReconnectTimer();
    reconnectDelayMs = STREAM_RECONNECT_MIN_MS;
    if (streamSocket && streamSocket.readyState < WebSocket.CLOSING) {
      streamSocket.close();
    }
    streamSocket = null;
  }

  function scheduleStreamReconnect(jobId: string): void {
    if (currentJobId !== jobId || streamSocket !== null || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (currentJobId === jobId && streamSocket === null) {
        void openStream(jobId);
      }
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, STREAM_RECONNECT_MAX_MS);
  }

  function streamUrl(jobId: string): URL {
    const url = new URL(`/api/jobs/${encodeURIComponent(jobId)}/stream`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  function appendStreamFrame(frame: StreamFrame): void {
    if (!detailState || detailState.jobId !== currentJobId) return;
    if (frame.event !== "msg.new") return;
    if (frame.data.job_id !== currentJobId) return;
    if (detailState.seenMessageIds.has(frame.data.id)) return;
    detailState.seenMessageIds.add(frame.data.id);
    renderMessage(detailState.messagesEl, frame.data);
  }

  function openStream(jobId: string): void {
    closeStream();
    if (!currentJobId || currentJobId !== jobId) return;
    const socket = new WebSocket(streamUrl(jobId).toString());
    streamSocket = socket;

    socket.addEventListener("open", () => {
      if (streamSocket !== socket) return;
      reconnectDelayMs = STREAM_RECONNECT_MIN_MS;
    });
    socket.addEventListener("message", (event) => {
      if (streamSocket !== socket) return;
      if (typeof event.data !== "string") return;
      let frame: StreamFrame | null = null;
      try {
        frame = JSON.parse(event.data) as StreamFrame;
      } catch {
        return;
      }
      appendStreamFrame(frame);
    });
    socket.addEventListener("close", () => {
      if (streamSocket !== socket) return;
      streamSocket = null;
      if (currentJobId === jobId) {
        scheduleStreamReconnect(jobId);
      }
    });
    socket.addEventListener("error", () => {
      if (streamSocket === socket) {
        // close will schedule reconnect.
      }
    });
  }

  function ensureStream(jobId: string): void {
    if (currentJobId !== jobId) return;
    if (streamSocket !== null || reconnectTimer !== null) return;
    openStream(jobId);
  }

  async function refreshJobs(): Promise<void> {
    const res = (await api("/api/jobs", { headers: {} })) as { jobs: JobSummary[] };
    renderJobs(jobsHost, res.jobs, (id) => {
      if (currentJobId !== id) closeStream();
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
    if (currentJobId !== id) return;
    detailState = renderJobDetail(detail, res, {
      async tell(jobId, message) {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/tell`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
        await refreshJobs();
        await refreshDetail(jobId);
        setBannerStatus("authenticated");
      },
      async stop(jobId) {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/stop`, {
          method: "POST",
          body: "{}",
        });
        await refreshJobs();
        await refreshDetail(jobId);
        setBannerStatus("authenticated");
      },
      async kill(jobId) {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/kill`, {
          method: "POST",
          body: "{}",
        });
        await refreshJobs();
        await refreshDetail(jobId);
        setBannerStatus("authenticated");
      },
      reportError: showError,
    });
    ensureStream(id);
  }

  createForm.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    const goal = goalInput.value.trim();
    const cwd = cwdInput.value.trim();
    const id = idInput.value.trim();
    if (!goal || !cwd) return;
    try {
      const created = await api<{ job: JobSummary["job"] }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          goal,
          cwd,
          ...(id ? { id } : {}),
        }),
      });
      goalInput.value = "";
      cwdInput.value = "";
      idInput.value = "";
      currentJobId = created.job.id;
      await refreshJobs();
      await refreshDetail(created.job.id);
      setBannerStatus("authenticated");
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "create failed");
    }
  });

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
    } catch (err) {
      csrfToken = "";
      closeStream();
      showError(err instanceof ApiError ? err.message : "login failed");
    }
  });

  function updatePushToggle(subscribed: boolean): void {
    pushToggle.textContent = subscribed ? "Disable notifications" : "Enable notifications";
    pushToggle.dataset.subscribed = subscribed ? "1" : "0";
  }

  async function initPush(): Promise<void> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      pushRegistration = reg;
      const existing = await reg.pushManager.getSubscription();
      updatePushToggle(existing !== null);
      pushToggle.classList.remove("push-toggle--hidden");
    } catch {
      // push not available in this context
    }
  }

  async function subscribePush(): Promise<void> {
    if (!pushRegistration) return;
    const configRes = await api<{ vapidPublicKey: string }>("/api/push/config");
    const appServerKey = Uint8Array.from(
      [...atob(configRes.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/"))].map((c) =>
        c.charCodeAt(0),
      ),
    );
    const sub = await pushRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
    const json = sub.toJSON() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    updatePushToggle(true);
  }

  async function unsubscribePush(): Promise<void> {
    if (!pushRegistration) return;
    const sub = await pushRegistration.pushManager.getSubscription();
    if (!sub) {
      updatePushToggle(false);
      return;
    }
    await sub.unsubscribe();
    await api("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    updatePushToggle(false);
  }

  pushToggle.addEventListener("click", async () => {
    const subscribed = pushToggle.dataset.subscribed === "1";
    try {
      if (subscribed) {
        await unsubscribePush();
      } else {
        const perm = await Notification.requestPermission();
        if (perm === "granted") await subscribePush();
      }
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "push toggle failed");
    }
  });

  startPolling(async () => {
    await refreshSession();
    if (csrfToken) {
      await refreshJobs();
      await initPush();
    }
  }, POLL_MS);
}

if (typeof document !== "undefined") {
  const root = document.getElementById("app");
  if (root) mountApp(root);
}
