import { MockKimiCLIClient } from "./workflow.ts";

const client = new MockKimiCLIClient();
const system = `You are a test developer. Given a project requirement and architecture, design tests that cover ALL functional points of the requirement.

You are running inside the project's codebase. ACTUALLY CREATE the test files on disk — do not just print code in your reply.
- Follow the project's existing test framework and conventions if it has any (e.g. playwright, vitest, bun test). Otherwise create the tests under tests/e2e/ using Playwright.
- Cover EVERY functional point / user journey from the requirement. Do not skip any scope item.
- Write runnable tests against the interfaces described in the architecture.

After writing all files, return ONLY a JSON object in this shape:
{
  "files": [
    {
      "path": "tests/e2e/login.spec.ts",
      "covers": "short description of what this file tests",
      "code": "full test file source code as a string"
    }
  ],
  "testTasks": [
    {
      "id": "TE1",
      "title": "E2E: short title",
      "description": "what functional point this task covers",
      "tag": "test",
      "dependencies": [],
      "acceptanceCriteria": ["Test file exists", "Test passes locally", "Covers ..."],
      "assignee": "TestDeveloper",
      "testFile": "tests/e2e/login.spec.ts"
    }
  ]
}

Rules:
- Generate one test task per functional point / user journey. All functional points in the requirement must be covered.
- Each test task must correspond to one file in "files" via the "testFile" field.
- Set dependencies to [] for now; the PM will wire them to the implementation tasks they validate.`;

const raw = await client.complete(system, "Requirement: test");
console.log(raw);
