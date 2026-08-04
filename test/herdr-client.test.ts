import { describe, expect, it } from "bun:test";
import { createHerdrClient } from "../src/herdr/client.ts";

/** Fakes `Bun.spawn`'s surface for a subprocess that prints `stdout` and exits `exitCode`. */
function fakeSpawn(
  stdout: string,
  exitCode: number,
  opts: { hang?: boolean } = {},
): ReturnType<typeof Bun.spawn> {
  let killed = false;
  const exited = opts.hang
    ? new Promise<number>((resolve) => {
        // resolves only if kill() is called, simulating a hung process being reaped
        const check = (): void => {
          if (killed) resolve(exitCode);
          else setTimeout(check, 5);
        };
        check();
      })
    : Promise.resolve(exitCode);
  return {
    stdout: new Response(stdout).body,
    exited,
    kill: () => {
      killed = true;
    },
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("createHerdrClient", () => {
  it("resolveWorkspaceName finds the matching workspace label", async () => {
    const client = createHerdrClient({
      spawn: () =>
        fakeSpawn(
          JSON.stringify({
            result: {
              workspaces: [
                { workspace_id: "w1", label: "agvsr" },
                { workspace_id: "w2", label: "other" },
              ],
            },
          }),
          0,
        ),
    });
    expect(await client.resolveWorkspaceName("w1")).toBe("agvsr");
    expect(await client.resolveWorkspaceName("w9")).toBeNull();
  });

  it("resolveWorkspaceName returns null on non-zero exit", async () => {
    const client = createHerdrClient({ spawn: () => fakeSpawn("", 1) });
    expect(await client.resolveWorkspaceName("w1")).toBeNull();
  });

  it("resolveWorkspaceName returns null on malformed JSON", async () => {
    const client = createHerdrClient({ spawn: () => fakeSpawn("not json", 0) });
    expect(await client.resolveWorkspaceName("w1")).toBeNull();
  });

  it("resolveWorkspaceName returns null if the binary is missing", async () => {
    const client = createHerdrClient({
      spawn: () => {
        throw new Error("spawn ENOENT herdr");
      },
    });
    expect(await client.resolveWorkspaceName("w1")).toBeNull();
  });

  it("resolveWorkspaceName gives up and returns null after the timeout", async () => {
    const client = createHerdrClient({
      timeoutMs: 20,
      spawn: () => fakeSpawn("", 0, { hang: true }),
    });
    expect(await client.resolveWorkspaceName("w1")).toBeNull();
  });

  it("promptAgent sends the pane id and text as args and never throws", async () => {
    let seenArgs: string[] = [];
    const client = createHerdrClient({
      spawn: (args) => {
        seenArgs = args;
        return fakeSpawn("", 0);
      },
    });
    await client.promptAgent("w1:p1", "hello there");
    expect(seenArgs).toEqual(["agent", "prompt", "w1:p1", "hello there"]);
  });

  it("promptAgent swallows a non-zero exit without throwing", async () => {
    const client = createHerdrClient({ spawn: () => fakeSpawn("", 1) });
    await expect(client.promptAgent("w1:p1", "hi")).resolves.toBeUndefined();
  });

  it("passes HERDR_SESSION through to the spawned process env", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    const client = createHerdrClient({
      spawn: (_args, env) => {
        seenEnv = env;
        return fakeSpawn(JSON.stringify({ result: { workspaces: [] } }), 0);
      },
    });
    await client.resolveWorkspaceName("w1", "work");
    expect(seenEnv.HERDR_SESSION).toBe("work");
  });
});
