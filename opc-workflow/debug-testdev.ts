import { MockKimiCLIClient } from "./workflow.ts";

const client = new MockKimiCLIClient();
const system = `You are a test developer. Given a project requirement and architecture, design end-to-end test cases.
Return ONLY a JSON object in this shape:
{
  "tests": ["string", "string", ...]
}`;
const raw = await client.complete(system, "Requirement: test");
console.log(raw);
