/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  let jobId = "unknown";
  let status = "updated";
  if (event.data) {
    try {
      const payload = JSON.parse(event.data.text()) as { job_id?: string; status?: string };
      if (typeof payload.job_id === "string") jobId = payload.job_id;
      if (typeof payload.status === "string") status = payload.status;
    } catch {
      // malformed payload: use defaults
    }
  }
  const body = `Job ${jobId.slice(0, 8)} ${status}`;
  event.waitUntil(
    self.registration.showNotification("agvsr", {
      body,
      tag: jobId,
      data: { jobId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { jobId?: string } | null;
  const jobId = data?.jobId ?? "";
  const url = jobId ? `/#/jobs/${encodeURIComponent(jobId)}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          void client.focus();
          void client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
