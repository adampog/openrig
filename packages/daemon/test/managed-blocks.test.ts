import { describe, it, expect } from "vitest";
import {
  mergeManagedBlock,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  type ManagedBlockMergeFsOps,
} from "../src/domain/managed-blocks.js";

function memoryFs(initial: Record<string, string> = {}): ManagedBlockMergeFsOps & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    exists: (p) => p in files,
    readFile: (p) => files[p]!,
    writeFile: (p, c) => { files[p] = c; },
    mkdirp: () => {},
  };
}

const TARGET = "/seat/CLAUDE.md";
const block = (id: string, content: string) => `${MANAGED_BLOCK_START(id)}\n${content}\n${MANAGED_BLOCK_END(id)}`;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// Replacement-pattern look-alikes that String.prototype.replace gives special meaning when the
// replacement is a string: $' (text after the match), $` (before), $& (the match), $$ and $<digit>.
const CASES: Array<[string, string]> = [
  ["$'", "grep -cE '^(a|b)$'"],
  ["$`", "echo $`date`"],
  ["$&", "price is $& each"],
  ["$$", "pid is $$ here"],
  ["$1", "arg $1 and $12"],
];

describe("mergeManagedBlock keeps culture text byte for byte", () => {
  for (const [name, text] of CASES) {
    const content = `# Culture\n\n\`\`\`sh\n${text}\n\`\`\`\n\nAfter the fence.`;

    it(`${name}: first write into a new file`, () => {
      const fs = memoryFs();
      mergeManagedBlock(fs, TARGET, "culture", content);
      expect(fs.files[TARGET]).toBe(block("culture", content));
    });

    it(`${name}: rewriting a file that already holds the block replaces it in place, with the user's text around it untouched`, () => {
      const before = "# My notes\n\nkeep this";
      const after = "trailing user text with $' and $& in it";
      const fs = memoryFs({ [TARGET]: `${before}\n\n${block("culture", "old")}\n\n${block("other", "other body")}\n\n${after}` });
      mergeManagedBlock(fs, TARGET, "culture", content);
      expect(fs.files[TARGET]).toBe(`${before}\n\n${block("culture", content)}\n\n${block("other", "other body")}\n\n${after}\n`);
    });

    it(`${name}: re-launch is idempotent and never duplicates a block`, () => {
      const fs = memoryFs();
      mergeManagedBlock(fs, TARGET, "culture", content);
      mergeManagedBlock(fs, TARGET, "other", "other body");
      const once = fs.files[TARGET]!;
      mergeManagedBlock(fs, TARGET, "culture", content);
      mergeManagedBlock(fs, TARGET, "other", "other body");
      mergeManagedBlock(fs, TARGET, "culture", content);
      const text = fs.files[TARGET]!;
      expect(count(text, MANAGED_BLOCK_START("culture"))).toBe(1);
      expect(count(text, MANAGED_BLOCK_END("culture"))).toBe(1);
      expect(count(text, MANAGED_BLOCK_START("other"))).toBe(1);
      expect(text.trim()).toBe(once.trim());
      expect(text).toContain(content);
    });
  }

  it("a replaceBlockIds block is removed without splicing anything into the file", () => {
    const fs = memoryFs({ [TARGET]: `${block("old-id", "stale")}\n\n${block("culture", "old")}\n` });
    mergeManagedBlock(fs, TARGET, "culture", "new $' text", { replaceBlockIds: ["old-id"] });
    const text = fs.files[TARGET]!;
    expect(count(text, MANAGED_BLOCK_START("old-id"))).toBe(0);
    expect(text).toContain(block("culture", "new $' text"));
  });

  it("collapses a block that an earlier bug wrote more than once into a single block", () => {
    const fs = memoryFs({ [TARGET]: `${block("culture", "v1")}\n\nmiddle\n\n${block("culture", "v1")}\n` });
    mergeManagedBlock(fs, TARGET, "culture", "v2");
    const text = fs.files[TARGET]!;
    expect(count(text, MANAGED_BLOCK_START("culture"))).toBe(1);
    expect(text).toContain("middle");
    expect(text).toContain(block("culture", "v2"));
  });

  it("repairs the file shape the old splice produced: other blocks spliced inside the culture block and repeated after it", () => {
    const corrupt = [
      block("default", "floor"),
      `${MANAGED_BLOCK_START("culture")}\nstart of culture\n\`\`\`sh\ngrep -c 'x$`,
      block("start", "spliced start"),
      block("onboarding", "spliced onboarding"),
      `${MANAGED_BLOCK_END("culture")}`,
      block("start", "spliced start"),
      block("onboarding", "spliced onboarding"),
    ].join("\n\n");
    const fs = memoryFs({ [TARGET]: `${corrupt}\n` });
    const culture = "start of culture\n```sh\ngrep -c 'x$'\n```";
    mergeManagedBlock(fs, TARGET, "culture", culture);
    mergeManagedBlock(fs, TARGET, "start", "spliced start");
    mergeManagedBlock(fs, TARGET, "onboarding", "spliced onboarding");
    const text = fs.files[TARGET]!;
    for (const id of ["default", "culture", "start", "onboarding"]) {
      expect(count(text, MANAGED_BLOCK_START(id))).toBe(1);
      expect(count(text, MANAGED_BLOCK_END(id))).toBe(1);
    }
    expect(text).toContain(block("culture", culture));
  });
});
