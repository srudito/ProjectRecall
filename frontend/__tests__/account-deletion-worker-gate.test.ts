import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("account deletion local worker gate", () => {
  for (const relativePath of [
    "src/services/sync/project-sync-worker.ts",
    "src/services/sync/recording-upload-worker.ts",
    "src/services/sync/media-upload-worker.ts",
    "src/services/sync/session-deletion-worker.ts",
  ]) {
    it(`stops claims and exposes idle waiting in ${relativePath}`, () => {
      const source = readSource(relativePath);
      expect(source).toContain("isAccountDeletionLocallyPending()");
      expect(source).toContain("waitForIdle");
      expect(source).toMatch(/if \(isAccountDeletionLocallyPending\(\)\)/);
    });
  }

  it("prevents lifecycle events from scheduling new sync while a marker is active", () => {
    const coordinator = readSource(
      "src/services/sync/ProjectSyncCoordinator.tsx",
    );
    expect(coordinator).toContain(
      "if (isAccountDeletionLocallyPending()) return",
    );
  });
});
