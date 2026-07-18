#!/usr/bin/env bun
/**
 * Multi-Agent Workflow Orchestrator with Kimi CLI integration.
 *
 * Each agent invokes the local `kimi` CLI to perform real work.
 * Use `--mock-llm` to run without real LLM calls (for flow verification).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ============================================================================
// Types
// ============================================================================

type TaskTag = "backend" | "frontend" | "design" | "test" | "management";
type TaskStatus = "pending" | "running" | "passed" | "failed" | "done";

interface Artifact {
  name: string;
  content: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  tag: TaskTag;
  dependencies: string[];
  acceptanceCriteria: string[];
  assignee: string;
  status: TaskStatus;
  artifacts: Artifact[];
  output: string;
  validationErrors: string[];
  retryCount: number;
}

interface RequirementDoc {
  raw: string;
  refined: string;
  scope: string[];
}

interface ArchitectureDoc {
  overview: string;
  components: string[];
  techStack: string[];
}

interface WorkflowResult {
  requirement: RequirementDoc;
  architecture: ArchitectureDoc;
  tasks: Task[];
  tests: string[];
  finalStatus: "success" | "failure";
}

type ReviewAction = "approve" | "revise" | "question";

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(agent: string, message: string): void {
  const now = new Date().toISOString();
  console.log(`[${now}] [${agent}] ${message}`);
}

function topologicalSort(tasks: Task[]): Task[] {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: Task[] = [];

  function visit(task: Task, stack: Set<string>) {
    if (visited.has(task.id)) return;
    if (stack.has(task.id)) {
      throw new Error(`Circular dependency detected at task ${task.id}`);
    }
    stack.add(task.id);
    for (const depId of task.dependencies) {
      const dep = map.get(depId);
      if (!dep) throw new Error(`Missing dependency ${depId} for task ${task.id}`);
      visit(dep, stack);
    }
    stack.delete(task.id);
    visited.add(task.id);
    result.push(task);
  }

  for (const task of tasks) visit(task, new Set());
  return result;
}

function extractJsonBlock(text: string): any {
  // Try fenced code block first.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch && fenceMatch[1] ? fenceMatch[1].trim() : text.trim();

  // Try to find the first JSON object/array.
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);

  let jsonText = "";
  if (objectMatch && arrayMatch) {
    const objStart = candidate.indexOf("{");
    const arrStart = candidate.indexOf("[");
    jsonText = objStart < arrStart ? objectMatch[0] : arrayMatch[0];
  } else if (objectMatch) {
    jsonText = objectMatch[0];
  } else if (arrayMatch) {
    jsonText = arrayMatch[0];
  } else {
    throw new Error("No JSON object or array found in response");
  }

  return JSON.parse(jsonText);
}

function extractCodeBlock(text: string, language?: string): string {
  const pattern = language
    ? new RegExp(`\\\`\\\`\\\`${language}\\s*([\\s\\S]*?)\\\`\\\`\\\``)
    : /```(?:\w+)?\s*([\s\S]*?)```/;
  const match = text.match(pattern);
  if (match && match[1]) return match[1].trim();
  // If no code block, return the trimmed text itself.
  return text.trim();
}

const RUNS_DIR = "runs";

function statePathFor(id: string): string {
  return join(RUNS_DIR, id, "state.json");
}

function outputPathFor(id: string): string {
  return join(RUNS_DIR, id, "output.json");
}

function saveState(ctx: WorkflowContext, path: string): void {
  const serializable = {
    id: ctx.id,
    userRequirement: ctx.userRequirement,
    requirement: ctx.requirement,
    architecture: ctx.architecture,
    tasks: ctx.tasks,
    tests: ctx.tests,
    finalStatus: ctx.finalStatus,
    feedback: ctx.feedback,
  };
  // Write-then-rename so a crash mid-write cannot corrupt the saved state.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(serializable, null, 2));
  renameSync(tmp, path);
}

function loadState(path: string): WorkflowContext | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WorkflowContext>;
    const ctx = new WorkflowContext(
      parsed.userRequirement || "",
      parsed.id || randomUUID()
    );
    ctx.requirement = parsed.requirement ?? null;
    ctx.architecture = parsed.architecture ?? null;
    ctx.tasks = parsed.tasks ?? [];
    ctx.tests = parsed.tests ?? [];
    ctx.finalStatus = parsed.finalStatus ?? "success";
    ctx.feedback = parsed.feedback ?? "";
    return ctx;
  } catch (err) {
    console.warn(`Failed to load state from ${path}:`, err);
    return null;
  }
}

const REWIND_PHASES = ["requirement", "architect", "pm", "test"] as const;
type RewindPhase = (typeof REWIND_PHASES)[number];

/**
 * Rewind a resumed workflow to a specific step so that step (and everything
 * downstream of it) runs again instead of being skipped.
 */
function rewindContext(ctx: WorkflowContext, from: string): void {
  const phaseAliases: Record<string, RewindPhase> = {
    requirement: "requirement",
    architect: "architect",
    architecture: "architect",
    pm: "pm",
    tasks: "pm",
    test: "test",
    tests: "test",
  };
  const phase = phaseAliases[from.toLowerCase()];
  if (phase) {
    const idx = REWIND_PHASES.indexOf(phase);
    if (idx <= 0) ctx.requirement = null;
    if (idx <= 1) ctx.architecture = null;
    if (idx <= 2) ctx.tasks = [];
    if (idx <= 3) ctx.tests = [];
    ctx.feedback = "";
    log(
      "WorkflowEngine",
      `rewound to phase "${phase}", downstream state cleared`
    );
    return;
  }

  const task = ctx.tasks.find((t) => t.id === from);
  if (!task) {
    throw new Error(
      `Unknown --from step "${from}". Use one of: requirement, architect, pm, test, or a task id (e.g. T3).`
    );
  }

  // Reset the task itself plus every task that transitively depends on it.
  const toReset = new Set<string>([task.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of ctx.tasks) {
      if (!toReset.has(t.id) && t.dependencies.some((d) => toReset.has(d))) {
        toReset.add(t.id);
        grew = true;
      }
    }
  }
  for (const t of ctx.tasks) {
    if (!toReset.has(t.id)) continue;
    t.status = "pending";
    t.artifacts = [];
    t.output = "";
    t.validationErrors = [];
    t.retryCount = 0;
  }
  log(
    "WorkflowEngine",
    `rewound to task ${task.id}, reset tasks: ${[...toReset].join(", ")}`
  );
}

// ============================================================================
// Kimi CLI client
// ============================================================================

interface KimiCLIClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

class RealKimiCLIClient implements KimiCLIClient {
  private timeoutMs: number;
  private workspaceDir: string;

  constructor(
    timeoutMs?: number,
    workspaceDir = process.env.KIMI_WORKSPACE || "/Users/logact/projects/OPC"
  ) {
    const envTimeout = process.env.KIMI_TIMEOUT_MS
      ? Number(process.env.KIMI_TIMEOUT_MS)
      : NaN;
    this.timeoutMs =
      timeoutMs ?? (Number.isFinite(envTimeout) ? envTimeout : 1_800_000);
    this.workspaceDir = workspaceDir;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const prompt = `${systemPrompt}\n\n${userPrompt}`.trim();
    log("KimiCLI", "sending prompt (calling kimi CLI)");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(this.workspaceDir, { recursive: true });

    const proc = Bun.spawn(
      ["kimi", "-p", prompt, "--output-format", "stream-json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.workspaceDir,
      }
    );

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, this.timeoutMs);

    try {
      await proc.exited;
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = proc.exitCode;

      if (timedOut) {
        throw new Error(
          `kimi CLI timed out after ${this.timeoutMs}ms and was killed. Increase the limit with KIMI_TIMEOUT_MS or --timeout.`
        );
      }
      if (exitCode !== 0) {
        throw new Error(
          `kimi CLI exited with ${exitCode}. stderr: ${stderrText.slice(0, 500)}`
        );
      }

      const assistantParts: string[] = [];
      for (const line of stdoutText.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.role === "assistant" && typeof event.content === "string") {
            assistantParts.push(event.content);
          }
        } catch {
          // Ignore malformed JSON lines.
        }
      }

      const result = assistantParts.join("").trim();
      if (!result) {
        throw new Error("kimi CLI returned empty assistant response");
      }
      log("KimiCLI", `received ${result.length} chars`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class MockKimiCLIClient implements KimiCLIClient {
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    await sleep(50);
    const lowerSystem = systemPrompt.toLowerCase();

    // Order matters: check more specific role phrases before generic substrings.
    if (lowerSystem.includes("requirement analyst")) {
      return JSON.stringify({
        refined: "Refined: " + userPrompt,
        scope: [
          "User authentication and authorization",
          "Core business feature implementation",
          "Responsive web UI",
          "End-to-end automated tests",
        ],
      });
    }

    if (lowerSystem.includes("project manager")) {
      return JSON.stringify([
        {
          id: "T1",
          title: "Design database schema",
          description: "Create the initial SQL schema based on architecture.",
          tag: "backend",
          dependencies: [],
          acceptanceCriteria: ["Schema file exists", "Tables cover all entities"],
          assignee: "BackendDeveloper",
        },
        {
          id: "T2",
          title: "Implement REST API",
          description: "Build Hono routes and handlers.",
          tag: "backend",
          dependencies: ["T1"],
          acceptanceCriteria: ["All endpoints respond 200", "Input validation works"],
          assignee: "BackendDeveloper",
        },
        {
          id: "T3",
          title: "Design UI mockups",
          description: "Create Figma-style design descriptions.",
          tag: "design",
          dependencies: [],
          acceptanceCriteria: ["Design system defined", "All screens covered"],
          assignee: "Designer",
        },
        {
          id: "T4",
          title: "Implement web frontend",
          description: "Build React components and pages.",
          tag: "frontend",
          dependencies: ["T3", "T2"],
          acceptanceCriteria: ["Pages render", "API integration works"],
          assignee: "FrontendDeveloper",
        },
      ]);
    }

    if (lowerSystem.includes("test developer")) {
      return JSON.stringify({
        tests: [
          "User can sign up and log in",
          "User can create and list resources",
          "UI renders on mobile and desktop",
        ],
      });
    }

    if (lowerSystem.includes("architect")) {
      return JSON.stringify({
        overview: "Architecture for: " + userPrompt,
        components: ["API Gateway", "Business Service", "Database", "Web Frontend"],
        techStack: ["Bun + TypeScript", "Hono", "SQLite", "React"],
      });
    }

    if (lowerSystem.includes("backend developer")) {
      return "```typescript\n// Auto-generated backend code for " + userPrompt + "\n```";
    }

    if (lowerSystem.includes("frontend developer")) {
      return "```tsx\n// Auto-generated frontend code for " + userPrompt + "\n```";
    }

    if (lowerSystem.includes("designer")) {
      return "```markdown\n# Design spec for " + userPrompt + "\n```";
    }

    if (lowerSystem.includes("backend validator")) {
      // Simulate a failure on first backend API validation to exercise Applicator.
      if (userPrompt.includes("T2") && userPrompt.includes("Retry attempt: 0")) {
        return JSON.stringify({
          status: "failed",
          errors: ["Missing input validation on POST /resources"],
        });
      }
      return JSON.stringify({ status: "passed", errors: [] });
    }

    if (lowerSystem.includes("frontend validator")) {
      return JSON.stringify({ status: "passed", errors: [] });
    }

    if (lowerSystem.includes("design validator")) {
      return JSON.stringify({ status: "passed", errors: [] });
    }

    if (lowerSystem.includes("applicator")) {
      return "```typescript\n// Fixed code for " + userPrompt + "\n```";
    }

    return "OK";
  }
}

// ============================================================================
// User interface for human-in-the-loop
// ============================================================================

class UserInterface {
  private rl: readline.Interface;
  private yesMode: boolean;
  private closed = false;

  constructor(yesMode = false) {
    this.rl = readline.createInterface({ input, output });
    this.yesMode = yesMode;
    this.rl.on("close", () => {
      this.closed = true;
    });
  }

  async ask(question: string): Promise<string> {
    if (this.closed) {
      throw new Error("Interactive input closed unexpectedly.");
    }
    const answer = await this.rl.question(`${question} `);
    return answer.trim();
  }

  async review(agentName: string, content: string): Promise<ReviewAction> {
    if (this.yesMode) {
      log("User", `[auto-approve] ${agentName}`);
      return "approve";
    }

    console.log("\n------------------------------------------------");
    console.log(`【${agentName} 的输出】`);
    console.log(content);
    console.log("------------------------------------------------");

    while (true) {
      const answer = await this.ask(
        "请输入操作：a(pprove 认可) / r(evise 要求修订) / q(uestion 质询)："
      );
      const lower = answer.toLowerCase();
      if (lower.startsWith("a")) return "approve";
      if (lower.startsWith("r")) return "revise";
      if (lower.startsWith("q")) return "question";
      console.log("输入无效，请重新输入。");
    }
  }

  async collectFeedback(prompt: string): Promise<string> {
    console.log(prompt);
    const lines: string[] = [];
    while (true) {
      const line = await this.ask(
        "  (输入空行结束，或输入 /cancel 取消并返回上级)"
      );
      if (line === "/cancel") return "";
      if (line === "") break;
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * Decide whether a failed phase should be retried. In yes-mode the decision
   * is automatic and bounded by maxAutoRetries; otherwise the user is asked.
   */
  async shouldRetryAfterError(
    label: string,
    errorMessage: string,
    failureCount: number,
    maxAutoRetries: number
  ): Promise<boolean> {
    if (this.yesMode) {
      const retry = failureCount <= maxAutoRetries;
      log(
        "User",
        retry
          ? `[auto-retry] ${label} (failure ${failureCount}/${maxAutoRetries})`
          : `[auto-abort] ${label} after ${failureCount} failures`
      );
      return retry;
    }

    console.log(`\n【${label}】执行失败：${errorMessage}`);
    const answer = await this.ask(
      "输入 r 重试，其他任意键退出（进度已保存，可用 --resume 恢复）："
    );
    return answer.toLowerCase().startsWith("r");
  }

  close(): void {
    this.rl.close();
  }
}

// ============================================================================
// Agent base class
// ============================================================================

abstract class Agent {
  constructor(
    public readonly name: string,
    protected llm: KimiCLIClient
  ) {}

  async execute(ctx: WorkflowContext, task?: Task): Promise<void> {
    log(this.name, `starting ${task ? `task ${task.id}: ${task.title}` : "phase"}`);
    await this.run(ctx, task);
    log(this.name, `finished ${task ? `task ${task.id}` : "phase"}`);
  }

  protected abstract run(ctx: WorkflowContext, task?: Task): Promise<void>;
}

// ============================================================================
// Planning agents
// ============================================================================

class RequirementAnalyst extends Agent {
  constructor(llm: KimiCLIClient) {
    super("RequirementAnalyst", llm);
  }

  protected async run(ctx: WorkflowContext): Promise<void> {
    const system = `You are a requirement analyst. Your job is to take a raw user requirement and refine it into a clear, well-scoped requirement document.
Return ONLY a JSON object in this exact shape (no extra commentary):
{
  "refined": "string",
  "scope": ["string", "string", ...]
}`;

    const user = `Raw requirement: ${ctx.userRequirement}
${ctx.feedback ? `User revision feedback: ${ctx.feedback}` : ""}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    ctx.requirement = {
      raw: ctx.userRequirement,
      refined: parsed.refined || String(parsed),
      scope: Array.isArray(parsed.scope) ? parsed.scope : [],
    };
  }

  formatOutput(ctx: WorkflowContext): string {
    const r = ctx.requirement!;
    return [
      `原始需求：${r.raw}`,
      `规范化需求：${r.refined}`,
      `范围：`,
      ...r.scope.map((s) => `  - ${s}`),
    ].join("\n");
  }
}

class Architect extends Agent {
  constructor(llm: KimiCLIClient) {
    super("Architect", llm);
  }

  protected async run(ctx: WorkflowContext): Promise<void> {
    if (!ctx.requirement) throw new Error("Requirement document is missing");

    const system = `You are a software architect. Given a requirement document, produce a concise architecture design.
Return ONLY a JSON object in this exact shape:
{
  "overview": "string",
  "components": ["string", ...],
  "techStack": ["string", ...]
}`;

    const user = `Requirement document:\n${ctx.requirement.refined}\nScope: ${ctx.requirement.scope.join(", ")}
${ctx.feedback ? `User revision feedback: ${ctx.feedback}` : ""}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    ctx.architecture = {
      overview: parsed.overview || "",
      components: Array.isArray(parsed.components) ? parsed.components : [],
      techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
    };
  }

  formatOutput(ctx: WorkflowContext): string {
    const a = ctx.architecture!;
    return [
      `概要：${a.overview}`,
      `组件：`,
      ...a.components.map((c) => `  - ${c}`),
      `技术栈：`,
      ...a.techStack.map((t) => `  - ${t}`),
    ].join("\n");
  }
}

class ProjectManager extends Agent {
  constructor(llm: KimiCLIClient) {
    super("ProjectManager", llm);
  }

  protected async run(ctx: WorkflowContext): Promise<void> {
    if (!ctx.architecture) throw new Error("Architecture document is missing");

    const system = `You are a project manager. Given a requirement and architecture, break the work down into a dependency-ordered task list.
Return ONLY a JSON array of tasks in this exact shape:
[
  {
    "id": "T1",
    "title": "string",
    "description": "string",
    "tag": "backend|frontend|design",
    "dependencies": [],
    "acceptanceCriteria": ["string", ...],
    "assignee": "string"
  }
]
Tag rules:
- Assign each task the tag that matches its actual work: "backend", "frontend", or "design".
- Use "design" ONLY for tasks with genuine design work (UX/UI design, visual assets). Many tasks need no design at all — do not invent design tasks for them.
- NEVER create tasks for writing or running tests: testing is designed and executed separately by the Test Developer in a dedicated phase.
- Use dependency ids that reference earlier tasks.`;

    const user = `Requirement:\n${ctx.requirement!.refined}\n\nArchitecture:\n${
      ctx.architecture.overview
    }\nComponents: ${ctx.architecture.components.join(", ")}\nTech stack: ${ctx.architecture.techStack.join(", ")}
${ctx.feedback ? `User revision feedback: ${ctx.feedback}` : ""}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    const taskArray = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
      ? parsed.tasks
      : null;

    if (!taskArray) {
      throw new Error(
        `ProjectManager expected a JSON array of tasks, got: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }

    ctx.tasks = taskArray.map((t: any) => ({
      id: String(t.id),
      title: String(t.title),
      description: String(t.description),
      tag: String(t.tag) as TaskTag,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? t.acceptanceCriteria.map(String)
        : [],
      assignee: String(t.assignee),
      status: "pending" as TaskStatus,
      artifacts: [],
      output: "",
      validationErrors: [],
      retryCount: 0,
    }));
  }

  formatOutput(ctx: WorkflowContext): string {
    return ctx.tasks
      .map(
        (t) =>
          `${t.id}: [${t.tag}] ${t.title}\n  描述：${t.description}\n  依赖：${
            t.dependencies.join(", ") || "无"
          }\n  验收标准：\n${t.acceptanceCriteria
            .map((c) => `    - ${c}`)
            .join("\n")}`
      )
      .join("\n\n");
  }
}

// ============================================================================
// Implementation agents
// ============================================================================

class TestDeveloper extends Agent {
  constructor(llm: KimiCLIClient) {
    super("TestDeveloper", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    const system = `You are a test developer. Given a project requirement and architecture, write end-to-end tests for the project.

You are running inside the project's codebase. ACTUALLY CREATE the e2e test files on disk — do not just print code in your reply.
- Follow the project's existing test framework and conventions if it has any (e.g. playwright, vitest, bun test). Otherwise create the tests under tests/e2e/ using Playwright.
- Cover the critical user journeys from the requirement.
- Write runnable tests against the interfaces described in the architecture.

After writing all files, return ONLY a JSON object listing what you created, in this shape:
{
  "files": [
    {"path": "tests/e2e/login.spec.ts", "covers": "short description of what this file tests"}
  ]
}`;

    const user = task
      ? `Task: ${task.title}\n${task.description}`
      : `Requirement:\n${ctx.requirement!.refined}\n\nArchitecture:\n${
          ctx.architecture!.overview
        }\n${
          ctx.feedback
            ? `User revision feedback: ${ctx.feedback}\nRevise the existing test files on disk accordingly, then return the updated JSON summary.`
            : ""
        }`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    if (Array.isArray(parsed.files)) {
      ctx.tests = parsed.files.map((f: any) => {
        const path = String(f?.path ?? f);
        const covers = f?.covers ? ` — ${String(f.covers)}` : "";
        return `${path}${covers}`;
      });
    } else {
      // Fallback for the mock client and older responses: plain descriptions.
      ctx.tests = Array.isArray(parsed.tests) ? parsed.tests.map(String) : [];
    }
  }

  formatOutput(ctx: WorkflowContext): string {
    return ctx.tests.map((t, i) => `${i + 1}. ${t}`).join("\n");
  }
}

class BackendDeveloper extends Agent {
  constructor(llm: KimiCLIClient) {
    super("BackendDeveloper", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("BackendDeveloper requires a task");

    const system = `You are a backend developer using Bun + TypeScript + Hono. Implement the given task and return the code inside a markdown code block.
File extension should be .ts. Include brief comments explaining key decisions.`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}`;

    const raw = await this.llm.complete(system, user);
    task.status = "running";
    task.output = `Backend code for ${task.title}`;
    task.artifacts.push({
      name: `${task.id}_backend.ts`,
      content: extractCodeBlock(raw, "typescript"),
    });
    task.status = "done";
  }
}

class FrontendDeveloper extends Agent {
  constructor(llm: KimiCLIClient) {
    super("FrontendDeveloper", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("FrontendDeveloper requires a task");

    const system = `You are a frontend developer using React + TypeScript. Implement the given task and return the code inside a markdown code block.
File extension should be .tsx. Include brief comments explaining key decisions.`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}`;

    const raw = await this.llm.complete(system, user);
    task.status = "running";
    task.output = `Frontend code for ${task.title}`;
    task.artifacts.push({
      name: `${task.id}_frontend.tsx`,
      content: extractCodeBlock(raw, "tsx"),
    });
    task.status = "done";
  }
}

class Designer extends Agent {
  constructor(llm: KimiCLIClient) {
    super("Designer", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("Designer requires a task");

    const system = `You are a UI/UX designer. Produce a concise design specification for the given task inside a markdown code block.
Use markdown format. Cover layout, colors, typography, and interactions.`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}`;

    const raw = await this.llm.complete(system, user);
    task.status = "running";
    task.output = `Design artifacts for ${task.title}`;
    task.artifacts.push({
      name: `${task.id}_design.md`,
      content: extractCodeBlock(raw, "markdown") || extractCodeBlock(raw),
    });
    task.status = "done";
  }
}

class BackendValidator extends Agent {
  constructor(llm: KimiCLIClient) {
    super("BackendValidator", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("BackendValidator requires a task");

    const system = `You are a backend validator. Review the implementation against the acceptance criteria.
Return ONLY a JSON object:
{
  "status": "passed" | "failed",
  "errors": ["string", ...]
}
If failed, list concrete, actionable errors so a developer can fix them.`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}\nRetry attempt: ${task.retryCount}\n\nImplementation:\n${task.artifacts.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n")}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    task.validationErrors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [];
    task.status = parsed.status === "passed" ? "passed" : "failed";
    log(this.name, `validation result: ${task.status}`);
  }
}

class FrontendValidator extends Agent {
  constructor(llm: KimiCLIClient) {
    super("FrontendValidator", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("FrontendValidator requires a task");

    const system = `You are a frontend validator. Review the implementation against the acceptance criteria.
Return ONLY a JSON object:
{
  "status": "passed" | "failed",
  "errors": ["string", ...]
}`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}\nRetry attempt: ${task.retryCount}\n\nImplementation:\n${task.artifacts.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n")}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    task.validationErrors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [];
    task.status = parsed.status === "passed" ? "passed" : "failed";
    log(this.name, `validation result: ${task.status}`);
  }
}

class DesignValidator extends Agent {
  constructor(llm: KimiCLIClient) {
    super("DesignValidator", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("DesignValidator requires a task");

    const system = `You are a design validator. Review the design spec against the acceptance criteria.
Return ONLY a JSON object:
{
  "status": "passed" | "failed",
  "errors": ["string", ...]
}`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join("\n")}\nRetry attempt: ${task.retryCount}\n\nDesign spec:\n${task.artifacts.map((a) => a.content).join("\n\n")}`;

    const raw = await this.llm.complete(system, user);
    const parsed = extractJsonBlock(raw);
    task.validationErrors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [];
    task.status = parsed.status === "passed" ? "passed" : "failed";
    log(this.name, `validation result: ${task.status}`);
  }
}

class Applicator extends Agent {
  constructor(llm: KimiCLIClient) {
    super("Applicator", llm);
  }

  protected async run(ctx: WorkflowContext, task?: Task): Promise<void> {
    if (!task) throw new Error("Applicator requires a task");
    task.retryCount += 1;

    const system = `You are a fixer. Given validation errors and the current implementation, produce a corrected version of the code/design.
Return the fixed artifact inside a markdown code block.`;

    const user = `Task: ${task.title}\nDescription: ${task.description}\nValidation errors:\n${task.validationErrors
      .map((e) => `- ${e}`)
      .join("\n")}\n\nCurrent implementation:\n${task.artifacts
      .map((a) => `--- ${a.name} ---\n${a.content}`)
      .join("\n\n")}`;

    const raw = await this.llm.complete(system, user);
    const code = extractCodeBlock(raw);

    for (const artifact of task.artifacts) {
      artifact.content = code;
    }

    task.output += `\n// Fixed: ${task.validationErrors.join(", ")}`;
    task.validationErrors = [];
    task.status = "done";
    log(this.name, `applied fixes for ${task.id} (retry ${task.retryCount})`);
  }
}

// ============================================================================
// Workflow context & engine
// ============================================================================

export class WorkflowContext {
  id: string;
  userRequirement = "";
  requirement: RequirementDoc | null = null;
  architecture: ArchitectureDoc | null = null;
  tasks: Task[] = [];
  tests: string[] = [];
  finalStatus: "success" | "failure" = "success";
  feedback = "";

  constructor(requirement: string, id: string = randomUUID()) {
    this.userRequirement = requirement;
    this.id = id;
  }
}

export class WorkflowEngine {
  private readonly agents: {
    RequirementAnalyst: RequirementAnalyst;
    Architect: Architect;
    ProjectManager: ProjectManager;
    TestDeveloper: TestDeveloper;
    BackendDeveloper: BackendDeveloper;
    FrontendDeveloper: FrontendDeveloper;
    Designer: Designer;
    BackendValidator: BackendValidator;
    FrontendValidator: FrontendValidator;
    DesignValidator: DesignValidator;
    Applicator: Applicator;
  };

  private readonly maxRetries = 2;
  // Auto-retries for a failed planning-phase LLM call in non-interactive mode.
  private readonly maxPhaseRetries = 2;
  private readonly ui: UserInterface;
  private readonly statePath: string;

  constructor(llm: KimiCLIClient, statePath: string, yesMode = false) {
    this.ui = new UserInterface(yesMode);
    this.statePath = statePath;
    this.agents = {
      RequirementAnalyst: new RequirementAnalyst(llm),
      Architect: new Architect(llm),
      ProjectManager: new ProjectManager(llm),
      TestDeveloper: new TestDeveloper(llm),
      BackendDeveloper: new BackendDeveloper(llm),
      FrontendDeveloper: new FrontendDeveloper(llm),
      Designer: new Designer(llm),
      BackendValidator: new BackendValidator(llm),
      FrontendValidator: new FrontendValidator(llm),
      DesignValidator: new DesignValidator(llm),
      Applicator: new Applicator(llm),
    };
  }

  private save(ctx: WorkflowContext): void {
    saveState(ctx, this.statePath);
  }

  async run(
    ctx: WorkflowContext,
    options: { from?: string | null } = {}
  ): Promise<WorkflowResult> {
    if (options.from) {
      rewindContext(ctx, options.from);
      this.save(ctx);
    }

    try {
      log("WorkflowEngine", "==== Phase 1: Planning ====");

      await this.reviewablePhase(
        ctx,
        this.agents.RequirementAnalyst,
        "需求分析师",
        (c) => this.agents.RequirementAnalyst.formatOutput(c)
      );

      await this.reviewablePhase(
        ctx,
        this.agents.Architect,
        "架构师",
        (c) => this.agents.Architect.formatOutput(c)
      );

      await this.reviewablePhase(
        ctx,
        this.agents.ProjectManager,
        "项目经理",
        (c) => this.agents.ProjectManager.formatOutput(c)
      );

      log("WorkflowEngine", "==== Phase 2: Test Design ====");
      await this.reviewablePhase(
        ctx,
        this.agents.TestDeveloper,
        "测试开发",
        (c) => this.agents.TestDeveloper.formatOutput(c)
      );

      log("WorkflowEngine", "==== Phase 3: Implementation ====");

      const sorted = topologicalSort(ctx.tasks);

      const executed = new Set<string>();
      // TODO : Consider parallel execution of independent tasks.
      while (executed.size < sorted.length) {
        const ready = sorted.filter(
          (t) =>
            !executed.has(t.id) &&
            t.dependencies.every((depId) => executed.has(depId))
        );

        if (ready.length === 0) {
          throw new Error("Deadlock in task execution");
        }

        await Promise.all(
          ready.map(async (task) => {
            await this.executeTaskWithValidation(ctx, task);
            executed.add(task.id);
          })
        );
      }

      log("WorkflowEngine", "==== Phase 4: Local Verification ====");
      const failedTasks = ctx.tasks.filter(
        (t) => t.status !== "passed" && t.status !== "done"
      );
      if (failedTasks.length > 0) {
        ctx.finalStatus = "failure";
        log(
          "WorkflowEngine",
          `verification failed for: ${failedTasks.map((t) => t.id).join(", ")}`
        );
      } else {
        ctx.finalStatus = "success";
        log("WorkflowEngine", "all tasks passed local verification");
      }

      log("WorkflowEngine", "==== Phase 5: CI / PR Summary ====");
      log("WorkflowEngine", `final status: ${ctx.finalStatus}`);
      log("WorkflowEngine", "simulated PR created and ready for review");

      return {
        requirement: ctx.requirement!,
        architecture: ctx.architecture!,
        tasks: ctx.tasks,
        tests: ctx.tests,
        finalStatus: ctx.finalStatus,
      };
    } finally {
      this.ui.close();
    }
  }

  private async reviewablePhase(
    ctx: WorkflowContext,
    agent: RequirementAnalyst | Architect | ProjectManager | TestDeveloper,
    label: string,
    formatter: (ctx: WorkflowContext) => string
  ): Promise<void> {
    // Skip if this phase was already completed and persisted.
    const alreadyDone =
      (agent instanceof RequirementAnalyst && ctx.requirement !== null) ||
      (agent instanceof Architect && ctx.architecture !== null) ||
      (agent instanceof ProjectManager && ctx.tasks.length > 0) ||
      (agent instanceof TestDeveloper && ctx.tests.length > 0);

    if (alreadyDone) {
      log(label, "skipping, already done (loaded from state)");
      return;
    }

    let failures = 0;
    while (true) {
      try {
        await agent.execute(ctx);
      } catch (err) {
        failures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        log(label, `execution failed (failure ${failures}): ${msg}`);
        const retry = await this.ui.shouldRetryAfterError(
          label,
          msg,
          failures,
          this.maxPhaseRetries
        );
        if (retry) continue;
        throw new Error(
          `Phase "${label}" aborted: ${msg}. Progress is saved; resume with --resume.`
        );
      }
      failures = 0;
      this.save(ctx);
      const action = await this.ui.review(label, formatter(ctx));

      if (action === "approve") {
        return;
      }

      if (action === "revise") {
        const feedback = await this.ui.collectFeedback(
          "请描述你的修改意见（输入空行结束）："
        );
        if (!feedback) continue;
        log(label, `received revision feedback: ${feedback.slice(0, 80)}...`);
        ctx.feedback = feedback;
        continue;
      }

      if (action === "question") {
        const question = await this.ui.collectFeedback(
          "请输入你的质询（输入空行结束）："
        );
        if (!question) continue;
        // In a real LLM-backed system this would ask the agent for an answer.
        // For now we keep the placeholder behavior.
        console.log(
          `\n【${label} 回复】\n这是一个占位回复。在完整接入 Kimi agent 后，我会把你的质询“${question}”交给对应 Agent 重新分析并返回答案。\n`
        );
      }
    }
  }

  private async executeTaskWithValidation(
    ctx: WorkflowContext,
    task: Task
  ): Promise<void> {
    if (task.status === "done" || task.status === "passed") {
      log("WorkflowEngine", `skipping ${task.id}, already ${task.status}`);
      return;
    }

    try {
      const implementer = this.getImplementer(task.tag);
      await implementer.execute(ctx, task);
      this.save(ctx);

      let attempts = 0;
      while (attempts <= this.maxRetries) {
        const validator = this.getValidator(task.tag);
        await validator.execute(ctx, task);
        this.save(ctx);

        if (this.isFinished(task.status)) {
          await this.runLocalTest(task);
          this.save(ctx);
          return;
        }

        if (task.retryCount >= this.maxRetries) {
          log("WorkflowEngine", `${task.id} exceeded max retries`);
          task.status = "failed";
          this.save(ctx);
          return;
        }

        log("ApplicatorLoop", `${task.id} validation failed, applying fixes`);
        const applicator = this.getApplicator(task.tag);
        await applicator.execute(ctx, task);
        this.save(ctx);
        attempts += 1;
      }
    } catch (err) {
      task.status = "failed";
      task.output += `\nExecution error: ${err instanceof Error ? err.message : String(err)}`;
      log("WorkflowEngine", `${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.save(ctx);
    }
  }

  private getImplementer(tag: TaskTag): Agent {
    switch (tag) {
      case "backend":
        return this.agents.BackendDeveloper;
      case "frontend":
        return this.agents.FrontendDeveloper;
      case "design":
        return this.agents.Designer;
      case "test":
        return this.agents.TestDeveloper;
      default:
        throw new Error(`No implementer for tag ${tag}`);
    }
  }

  private getValidator(tag: TaskTag): Agent {
    switch (tag) {
      case "backend":
        return this.agents.BackendValidator;
      case "frontend":
        return this.agents.FrontendValidator;
      case "design":
        return this.agents.DesignValidator;
      case "test":
        return {
          name: "TestRunner",
          execute: async (_ctx: WorkflowContext, task?: Task) => {
            if (task) {
              task.status = "done";
              task.output = "E2E tests executed";
            }
          },
        } as Agent;
      default:
        throw new Error(`No validator for tag ${tag}`);
    }
  }

  private getApplicator(_tag: TaskTag): Agent {
    return this.agents.Applicator;
  }

  private isFinished(status: TaskStatus): boolean {
    return status === "passed" || status === "done";
  }

  private async runLocalTest(task: Task): Promise<void> {
    await sleep(100);
    if (task.status === "passed" || task.status === "done") {
      log("LocalTest", `${task.id} local test passed`);
      task.status = "done";
    }
  }
}

// ============================================================================
// Entry point
// ============================================================================

interface CliOptions {
  requirement: string;
  requirementProvided: boolean;
  yesMode: boolean;
  mockLlm: boolean;
  fresh: boolean;
  resumeId: string | null;
  fromStep: string | null;
  timeoutMs: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let yesMode = false;
  let mockLlm = false;
  let fresh = false;
  let resumeId: string | null = null;
  let fromStep: string | null = null;
  let timeoutMs: number | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-y" || a === "--yes") yesMode = true;
    else if (a === "--mock-llm") mockLlm = true;
    else if (a === "--fresh") fresh = true;
    else if (a === "--resume") resumeId = args[++i] ?? null;
    else if (a.startsWith("--resume=")) resumeId = a.slice("--resume=".length);
    else if (a === "--from") fromStep = args[++i] ?? null;
    else if (a.startsWith("--from=")) fromStep = a.slice("--from=".length);
    else if (a === "--timeout") timeoutMs = Number(args[++i]);
    else if (a.startsWith("--timeout="))
      timeoutMs = Number(a.slice("--timeout=".length));
    else positional.push(a);
  }

  const requirementProvided = positional.length > 0;
  const requirement =
    positional.join(" ") ||
    "Build a simple task management web app where users can create, edit, and mark tasks as complete.";
  return {
    requirement,
    requirementProvided,
    yesMode,
    mockLlm,
    fresh,
    resumeId,
    fromStep,
    timeoutMs,
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  if (
    opts.timeoutMs !== null &&
    (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
  ) {
    console.error("Invalid --timeout value; expected a positive number of milliseconds.");
    process.exit(1);
  }

  console.log("\n==============================================");
  console.log("Multi-Agent Workflow Orchestrator");
  console.log("==============================================\n");

  let ctx: WorkflowContext;
  if (opts.resumeId) {
    const loaded = loadState(statePathFor(opts.resumeId));
    if (!loaded) {
      console.error(
        `No saved workflow found for id "${opts.resumeId}" (expected ${statePathFor(opts.resumeId)}).`
      );
      process.exit(1);
    }
    ctx = loaded;
    if (opts.requirementProvided && opts.requirement !== ctx.userRequirement) {
      console.warn(
        "Warning: ignoring the requirement argument; using the saved requirement of the resumed workflow."
      );
    }
    if (opts.fresh) {
      // Keep the id so the restart overwrites this workflow's state in place.
      ctx = new WorkflowContext(ctx.userRequirement, ctx.id);
      console.log("Mode: fresh restart of existing workflow (state cleared)");
    } else {
      console.log(`Mode: resume workflow ${ctx.id}`);
    }
  } else {
    if (opts.fromStep) {
      console.error("--from requires --resume <id>.");
      process.exit(1);
    }
    ctx = new WorkflowContext(opts.requirement);
  }

  console.log(`Workflow ID: ${ctx.id}`);
  console.log(`User requirement: ${ctx.userRequirement}`);
  console.log(`State: ${statePathFor(ctx.id)}`);
  console.log(`Resume with: bun run workflow --resume ${ctx.id}\n`);

  if (opts.fromStep) {
    console.log(`Rewind: re-run from step "${opts.fromStep}"\n`);
  }
  if (opts.mockLlm) {
    console.log("Mode: mock LLM (no real Kimi calls)\n");
  } else if (opts.yesMode) {
    console.log("Mode: non-interactive with real Kimi CLI calls\n");
  } else {
    console.log("Mode: interactive with real Kimi CLI calls\n");
  }

  const llm: KimiCLIClient = opts.mockLlm
    ? new MockKimiCLIClient()
    : new RealKimiCLIClient(opts.timeoutMs ?? undefined);

  const engine = new WorkflowEngine(llm, statePathFor(ctx.id), opts.yesMode);
  const result = await engine.run(ctx, { from: opts.fromStep });

  const outPath = outputPathFor(ctx.id);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nResult written to ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
