import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "grok"));
const runProcessMock = vi.hoisted(() => vi.fn());
const isRemoteMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: isRemoteMock,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import {
  applyLocalBinPathForExecution,
  execute,
  prependLocalBinToPath,
  resolveGrokHeadlessPermissionMode,
  resolveHomeDir,
  resolvePathEnvKey,
} from "./execute.js";
import { resolveManagedGrokHomeDir } from "./grok-home.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

describe("grok_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
    isRemoteMock.mockReturnValue(false);
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
        ]),
      );
      // Grok >= 1.0 enforces `dontAsk` as deny-by-default over --always-approve,
      // so no permission mode may be passed unless explicitly configured.
      expect(args).not.toContain("--permission-mode");
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "paperclip", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("reports real per-run token usage, marks it as per_run, and only surfaces cost for API billing", async () => {
    runProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({
          type: "end",
          stopReason: "EndTurn",
          sessionId: "sess-1",
          requestId: "req-1",
          usage: { input_tokens: 2384, output_tokens: 261, cache_read_input_tokens: 23040 },
          total_cost_usd: 0.013246,
        }),
      ].join("\n"),
      stderr: "",
    }));

    const makeCtx = async (runId: string): Promise<AdapterExecutionContext> => ({
      runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot() },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    const previousApiKey = process.env.XAI_API_KEY;
    try {
      // Subscription billing (no XAI_API_KEY): token usage is populated, but
      // there is no marginal dollar cost so costUsd stays null. Clear the key
      // explicitly so the ambient environment (dev machine or CI with provider
      // secrets) cannot flip this branch to API billing.
      delete process.env.XAI_API_KEY;
      const subscriptionResult = await execute(await makeCtx("run-subscription"));
      expect(subscriptionResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "subscription",
        costUsd: null,
      });

      // API-key billing: same token usage, plus the real dollar cost.
      process.env.XAI_API_KEY = "test-key";
      const apiResult = await execute(await makeCtx("run-api"));
      expect(apiResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "api",
        costUsd: 0.013246,
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it("sets GROK_HOME to the company home in subscription mode, and leaves it unset when XAI_API_KEY exists", async () => {
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        stderr: "",
      };
    });

    const makeCtx = async (runId: string): Promise<AdapterExecutionContext> => ({
      runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot() },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    const previousApiKey = process.env.XAI_API_KEY;
    try {
      delete process.env.XAI_API_KEY;
      await execute(await makeCtx("run-subscription-home"));
      expect(seenEnv.GROK_HOME).toBe(resolveManagedGrokHomeDir(process.env, "company-1"));

      // The XAI_API_KEY path stays unchanged: no GROK_HOME is set when the key
      // exists, because the CLI authenticates via the environment variable
      // directly, not from the company Grok home's auth.json.
      process.env.XAI_API_KEY = "test-key";
      await execute(await makeCtx("run-api-home"));
      expect(seenEnv.GROK_HOME).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it("passes an explicitly configured permissionMode through to the CLI", async () => {
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        stderr: "",
      };
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-permission-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot(), permissionMode: "bypassPermissions" },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const flagIndex = seenArgs.indexOf("--permission-mode");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(seenArgs[flagIndex + 1]).toBe("bypassPermissions");
  });

  it("drops the headless-incompatible dontAsk permission mode", async () => {
    const root = await makeTempRoot();

    let capturedArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-remap",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root, permissionMode: "dontAsk" },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    expect(capturedArgs).not.toContain("--permission-mode");
    expect(capturedArgs).not.toContain("dontAsk");
    expect(capturedArgs).toContain("--always-approve");
  });

  it("launches the Grok process with $HOME/.local/bin prepended to PATH", async () => {
    vi.stubEnv("HOME", "/custom/home");
    vi.stubEnv("PATH", "/usr/bin");
    try {
      const root = await makeTempRoot();
      let capturedEnv: Record<string, string> = {};
      runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
        capturedEnv = options.env;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: [
            JSON.stringify({ type: "text", data: "done" }),
            JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
          ].join("\n"),
          stderr: "",
        };
      });

      const ctx: AdapterExecutionContext = {
        runId: "run-path",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Grok Agent",
          adapterType: "grok_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { cwd: root },
        context: {},
        authToken: "run-token",
        onLog: async () => {},
      };

      await execute(ctx);

      // The env handed to the spawn (not just the preflight check) must carry the prepend.
      expect(capturedEnv.PATH).toContain(path.join("/custom/home", ".local", "bin"));
      expect(capturedEnv.PATH?.startsWith(path.join("/custom/home", ".local", "bin"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not inject the local host PATH for remote execution targets", async () => {
    isRemoteMock.mockReturnValue(true);
    vi.stubEnv("HOME", "/custom/home");
    vi.stubEnv("PATH", "/usr/bin");
    try {
      const root = await makeTempRoot();
      let capturedEnv: Record<string, string> = {};
      runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
        capturedEnv = options.env;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: [
            JSON.stringify({ type: "text", data: "done" }),
            JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
          ].join("\n"),
          stderr: "",
        };
      });

      const ctx: AdapterExecutionContext = {
        runId: "run-remote",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Grok Agent",
          adapterType: "grok_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { cwd: root },
        context: {},
        // Shape doesn't matter here: readAdapterExecutionTarget is mocked to pass it
        // through and isRemoteMock drives the remote branch.
        executionTarget: { kind: "remote", transport: "ssh" } as unknown as AdapterExecutionContext["executionTarget"],
        authToken: "run-token",
        onLog: async () => {},
      };

      await execute(ctx);

      // The remote profile owns PATH; we must not clobber it with this host's local bin.
      expect(capturedEnv.PATH).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
  });
});

describe("resolveGrokHeadlessPermissionMode", () => {
  it("passes no mode when none is configured", () => {
    expect(resolveGrokHeadlessPermissionMode("")).toEqual({ mode: "", droppedMode: null });
    expect(resolveGrokHeadlessPermissionMode("   ")).toEqual({ mode: "", droppedMode: null });
  });

  it("drops the headless-incompatible dontAsk mode and records the origin", () => {
    expect(resolveGrokHeadlessPermissionMode("dontAsk")).toEqual({
      mode: "",
      droppedMode: "dontAsk",
    });
    expect(resolveGrokHeadlessPermissionMode("  dontAsk  ")).toEqual({
      mode: "",
      droppedMode: "dontAsk",
    });
  });

  it("passes through other modes unchanged", () => {
    for (const mode of ["bypassPermissions", "auto", "acceptEdits", "default", "plan"]) {
      expect(resolveGrokHeadlessPermissionMode(mode)).toEqual({ mode, droppedMode: null });
    }
  });
});

describe("resolveHomeDir", () => {
  it("prefers HOME over USERPROFILE", () => {
    expect(resolveHomeDir({ HOME: "/home/dev", USERPROFILE: "C:\\Users\\dev" })).toBe("/home/dev");
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    expect(resolveHomeDir({ USERPROFILE: "C:\\Users\\dev" })).toBe("C:\\Users\\dev");
  });

  it("falls back to os.homedir() when HOME and USERPROFILE are unset", () => {
    expect(resolveHomeDir({})).toBe(os.homedir());
  });
});

describe("prependLocalBinToPath", () => {
  it("prepends $HOME/.local/bin ahead of the existing PATH", () => {
    const result = prependLocalBinToPath({ HOME: "/paperclip", PATH: "/usr/local/bin:/usr/bin" });
    expect(result.PATH).toBe(`/paperclip/.local/bin${path.delimiter}/usr/local/bin:/usr/bin`);
  });

  it("is a no-op when $HOME/.local/bin is already on PATH", () => {
    const env = { HOME: "/paperclip", PATH: `/paperclip/.local/bin${path.delimiter}/usr/bin` };
    expect(prependLocalBinToPath(env)).toBe(env);
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    const result = prependLocalBinToPath({ USERPROFILE: "/Users/dev", PATH: "/usr/bin" });
    expect(result.PATH).toBe(`${path.join("/Users/dev", ".local", "bin")}${path.delimiter}/usr/bin`);
  });

  it("falls back to os.homedir() when HOME and USERPROFILE are unset", () => {
    const result = prependLocalBinToPath({ PATH: "/usr/bin" });
    expect(result.PATH).toBe(`${path.join(os.homedir(), ".local", "bin")}${path.delimiter}/usr/bin`);
  });

  it("sets PATH to just the local bin when PATH is empty", () => {
    expect(prependLocalBinToPath({ HOME: "/home/dev", PATH: "" }).PATH).toBe("/home/dev/.local/bin");
  });

  it("updates the Windows-style `Path` key when that is the one present", () => {
    const result = prependLocalBinToPath({ HOME: "/home/dev", Path: "/usr/bin" });
    expect(result.Path).toBe(`/home/dev/.local/bin${path.delimiter}/usr/bin`);
    expect(result.PATH).toBeUndefined();
  });
});

describe("applyLocalBinPathForExecution", () => {
  it("puts PATH only on spawnEnv for local targets, not on configEnv", () => {
    const configEnv: Record<string, string> = { PAPERCLIP_RUN_ID: "run-1" };
    const { spawnEnv, runtimeEnv } = applyLocalBinPathForExecution({
      configEnv,
      processEnv: { HOME: "/custom/home", PATH: "/usr/bin" },
      isRemote: false,
    });
    expect(configEnv.PATH).toBeUndefined();
    expect(spawnEnv.PATH?.startsWith(path.join("/custom/home", ".local", "bin"))).toBe(true);
    expect(runtimeEnv.PATH?.startsWith(path.join("/custom/home", ".local", "bin"))).toBe(true);
    expect(spawnEnv.PAPERCLIP_RUN_ID).toBe("run-1");
  });

  it("does not put PATH on spawnEnv for remote targets", () => {
    const { spawnEnv } = applyLocalBinPathForExecution({
      configEnv: { PAPERCLIP_RUN_ID: "run-1" },
      processEnv: { HOME: "/custom/home", PATH: "/usr/bin" },
      isRemote: true,
    });
    expect(spawnEnv.PATH).toBeUndefined();
  });
});

describe("resolvePathEnvKey", () => {
  it("prefers uppercase PATH", () => {
    expect(resolvePathEnvKey({ PATH: "/usr/bin", Path: "/other" })).toBe("PATH");
  });

  it("falls back to Windows-style Path when PATH is absent", () => {
    expect(resolvePathEnvKey({ Path: "/usr/bin" })).toBe("Path");
  });

  it("defaults to PATH when neither is set", () => {
    expect(resolvePathEnvKey({})).toBe("PATH");
  });
});
