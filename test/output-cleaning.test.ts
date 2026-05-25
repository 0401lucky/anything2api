import assert from "node:assert/strict";
import test from "node:test";

import { cleanAssistantOutput } from "../src/output-cleaning.js";

test("cleanAssistantOutput strips file-based reasoning blocks and preserves plain content", () => {
  const raw =
    '<file-based-block id="1" uiType="thinking" thinkingType="reasoning" text="Thought for 1.9s" subtext="line 1 &amp; line 2"></file-based-block>pong';

  const cleaned = cleanAssistantOutput(raw);

  assert.equal(cleaned.content, "pong");
  assert.match(cleaned.reasoning, /Thought for 1.9s/);
  assert.match(cleaned.reasoning, /line 1 & line 2/);
});
