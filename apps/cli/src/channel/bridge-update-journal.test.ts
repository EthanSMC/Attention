import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadUpdateJournal, saveUpdateJournal, updateJournalPath, newUpdateJournal, addUpdateEvent } from "./bridge-update-journal";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it("atomically persists private, bounded delivered history without pruning undelivered events", async () => {
    const home = await mkdtemp(join(tmpdir(), "attention-consent-"));
    homes.push(home);
    const journal = newUpdateJournal();
    for (let i = 0; i < 20; i++) {
        addUpdateEvent(journal, "a".repeat(64), String(i), "trusted control reply");
        journal.events.at(-1)!.delivery = i < 10 ? "delivered" : "pending";
    }
    await saveUpdateJournal(journal, home);
    const loaded = await loadUpdateJournal(home);
    expect(loaded.events.filter(e => e.delivery === "delivered")).toHaveLength(8);
    expect(loaded.events.filter(e => e.delivery === "pending")).toHaveLength(10);
    expect((await stat(updateJournalPath(home))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".attention/update"))).mode & 0o777).toBe(0o700);
    expect(await readFile(updateJournalPath(home), "utf8")).not.toContain("contextToken");
});
it("refuses an unknown journal schema rather than overwriting it", async () => {
    const home = await mkdtemp(join(tmpdir(), "attention-consent-"));
    homes.push(home);
    await saveUpdateJournal(newUpdateJournal(), home);
    await writeFile(updateJournalPath(home), JSON.stringify({ schemaVersion: 99 }));
    await expect(loadUpdateJournal(home)).rejects.toThrow("update_journal_invalid");
});
