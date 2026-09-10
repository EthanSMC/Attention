import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseBridgeUpdateManifest, type BridgeUpdateManifest } from "../bridge-update-contract";
import { updateDigest } from "./bridge-update-offer";
export type UpdatePhase = "offered" | "approved" | "downloading" | "waiting_safe_point" | "switching" | "started" | "deferred" | "expired" | "cancelled" | "failed" | "rolled_back";
export interface UpdateOperation {
    id: string;
    identity: string;
    owner: string;
    manifest: BridgeUpdateManifest;
    currentVersion: string;
    currentPermissionSha: string;
    phase: UpdatePhase;
    explicit: boolean;
    codeHash: string | null;
    expiresAt: number;
    approvedUntil: number | null;
    errors: number;
}
export interface UpdateEvent {
    id: string;
    owner: string;
    text: string;
    delivery: "pending" | "enqueued" | "delivered" | "superseded";
    offerId?: string;
    expiresAt?: number;
}
export interface UpdateJournal {
    schemaVersion: 1;
    operation: UpdateOperation | null;
    events: UpdateEvent[];
    consumed: string[];
    quarantine: string[];
    nextCheckAt: number;
    lastManualCheckAt: number | null;
    lastErrorCode: string | null;
}
export const updateJournalPath = (home: string): string => join(home, ".attention/update/wechat-update.json");
export const newUpdateJournal = (): UpdateJournal => ({ schemaVersion: 1, operation: null, events: [], consumed: [], quarantine: [], nextCheckAt: 0, lastManualCheckAt: null, lastErrorCode: null });
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function validate(value: unknown): UpdateJournal {
    const invalid = () => { throw new Error("update_journal_invalid"); };
    if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid();
    const j = value as UpdateJournal;
    if (j.schemaVersion !== 1 || !Array.isArray(j.events) || !Array.isArray(j.consumed) || !Array.isArray(j.quarantine) ||
        !j.consumed.every(sha) || !j.quarantine.every(sha) || !finite(j.nextCheckAt) || !(j.lastManualCheckAt === null || finite(j.lastManualCheckAt)) ||
        !(j.lastErrorCode === null || typeof j.lastErrorCode === "string" && /^[a-z_]{1,80}$/u.test(j.lastErrorCode)))
        return invalid();
    if (j.events.some(e => !e || !sha(e.id) || !sha(e.owner) || typeof e.text !== "string" || e.text.length > 2000 || !["pending", "enqueued", "delivered", "superseded"].includes(e.delivery) || (e.offerId !== undefined && !sha(e.offerId)) || (e.expiresAt !== undefined && !finite(e.expiresAt))))
        return invalid();
    if (j.operation !== null) {
        const o = j.operation;
        if (!o || !sha(o.id) || !sha(o.identity) || !sha(o.owner) || typeof o.explicit !== "boolean" || !(o.codeHash === null || sha(o.codeHash)) || !finite(o.expiresAt) || !(o.approvedUntil === null || finite(o.approvedUntil)) || !Number.isInteger(o.errors) || o.errors < 0 || o.errors > 3 || !sha(o.currentPermissionSha) || !/^\d+\.\d+\.\d+$/u.test(o.currentVersion) || !["offered", "approved", "downloading", "waiting_safe_point", "switching", "started", "deferred", "expired", "cancelled", "failed", "rolled_back"].includes(o.phase))
            return invalid();
        if (!parseBridgeUpdateManifest(o.manifest))
            return invalid();
    }
    return j;
}
export async function loadUpdateJournal(home: string): Promise<UpdateJournal> {
    try {
        const raw = await readFile(updateJournalPath(home), "utf8");
        if (raw.length > 1048576)
            throw new Error("update_journal_invalid");
        return validate(JSON.parse(raw));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return newUpdateJournal();
        throw error;
    }
}
export async function saveUpdateJournal(journal: UpdateJournal, home: string): Promise<void> {
    validate(journal);
    const delivered = journal.events.filter(e => e.delivery === "delivered" || e.delivery === "superseded").slice(-8);
    const output = { ...journal, events: journal.events.filter(e => e.delivery !== "delivered" && e.delivery !== "superseded" || delivered.includes(e)), consumed: journal.consumed.slice(-256), quarantine: journal.quarantine.slice(-64) };
    const path = updateJournalPath(home), directory = dirname(path), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
        await writeFile(temporary, `${JSON.stringify(output)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
        Object.assign(journal, output);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export function addUpdateEvent(journal: UpdateJournal, owner: string, key: string, text: string): void {
    const id = updateDigest(["wechat-update-event", owner, key]);
    if (!journal.events.some(e => e.id === id))
        journal.events.push({ id, owner, text, delivery: "pending" });
}
