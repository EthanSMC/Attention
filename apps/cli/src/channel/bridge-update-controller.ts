import { randomInt, randomUUID } from "node:crypto";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE, bridgeUpdateDecision, compareSemanticVersions, type BridgeUpdateManifest } from "../bridge-update-contract";
import { fetchAttentionPermissionProfile, fetchAttentionReleaseManifest, nodeRuntimeSatisfies } from "../release-client";
import { matchUpdateCommand, type UpdateCommand } from "./bridge-update-control";
import { addUpdateEvent, loadUpdateJournal, saveUpdateJournal, type UpdateJournal, type UpdateOperation } from "./bridge-update-journal";
import { ownerFingerprint, permissionChanges, releaseIdentity, updateDigest, type PermissionProfile } from "./bridge-update-offer";
import { activateBridgeUpdate, prepareBridgeUpdate, type BridgeUpdaterOptions, type PreparedBridgeUpdate } from "./bridge-updater";
import { loadManagedBridgeUpdateState } from "./managed-bridge";
import { completeInbound, enqueueOutbound } from "./queue";
import type { ChannelState } from "./state";
type Discovery = {
    manifest: BridgeUpdateManifest;
    changes: string[] | null;
    consent: boolean;
};
type JobResult = {
    kind: "check";
    manual: boolean;
    value: Discovery;
} | {
    kind: "prepare";
    id: string;
    value: PreparedBridgeUpdate;
} | {
    kind: "error";
    id: string | null;
    manual: boolean;
};
const ACTIVE = new Set(["approved", "downloading", "waiting_safe_point", "switching"]);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** One tick on the service loop owns all durable writes. Network jobs only return values. */
export class BridgeUpdateController {
    private journal: UpdateJournal | null = null;
    private job: Promise<void> | null = null;
    private result: JobResult | null = null;
    private abort: AbortController | null = null;
    private prepared: PreparedBridgeUpdate | null = null;
    private scanOffset = 0;
    private restart = false;
    private discardResult = false;
    constructor(private readonly options: BridgeUpdaterOptions & {
        currentProfile?: PermissionProfile;
    }) { }
    private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }
    get pausesBusiness(): boolean { return !!this.journal?.operation && ACTIVE.has(this.journal.operation.phase); }
    private async commit(next: UpdateJournal): Promise<void> {
        await saveUpdateJournal(next, this.options.homeDirectory);
        this.journal = next;
    }
    private copy(): UpdateJournal { return structuredClone(this.journal!); }
    private event(j: UpdateJournal, owner: string, key: string, text: string): void { addUpdateEvent(j, owner, key, text); }
    private jobOptions(): BridgeUpdaterOptions {
        const signal = this.abort!.signal;
        return { ...this.options, signal, fetchImpl: async (input, init) => {
                signal.throwIfAborted();
                return await (this.options.fetchImpl ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
            } };
    }
    private startCheck(manual: boolean): void {
        this.abort = new AbortController();
        const options = this.jobOptions();
        this.job = (async () => {
            try {
                const manifest = await fetchAttentionReleaseManifest({ ...options, timeoutMs: 15000 });
                if (!nodeRuntimeSatisfies(options.nodeVersion ?? process.versions.node, manifest.node))
                    throw new Error("node_version_unsupported");
                const consent = bridgeUpdateDecision({ ...options, manifest }) === "consent_required";
                let changes: string[] | null = [];
                if (consent) {
                    if (manifest.version.split(".")[0] !== options.currentVersion.split(".")[0])
                        changes = null;
                    else {
                        try {
                            changes = permissionChanges(this.options.currentProfile ?? ATTENTION_BRIDGE_PERMISSION_PROFILE, await fetchAttentionPermissionProfile({ ...options, sha256: manifest.permission_profile_sha256, timeoutMs: 15000 }));
                        }
                        catch {
                            changes = null;
                        }
                    }
                }
                this.result = { kind: "check", manual, value: { manifest, changes, consent } };
            }
            catch {
                this.result = { kind: "error", id: null, manual };
            }
        })();
    }
    private startPreparation(op: UpdateOperation): void {
        this.abort = new AbortController();
        const options = this.jobOptions();
        this.job = (async () => {
            try {
                this.result = { kind: "prepare", id: op.id, value: await prepareBridgeUpdate(options, op.manifest, op.codeHash ? op.identity : undefined) };
            }
            catch {
                this.result = { kind: "error", id: op.id, manual: op.explicit };
            }
        })();
    }
    private async reconcile(state: ChannelState): Promise<void> {
        const next = this.copy(), op = next.operation;
        next.nextCheckAt = 0; // Every actual service start checks immediately, not the previous process's timer.
        if (op && ACTIVE.has(op.phase)) {
            const managed = await loadManagedBridgeUpdateState(this.options.homeDirectory);
            if (op.phase === "switching" && this.options.currentVersion === op.manifest.version && this.options.currentPermissionProfileSha256 === op.manifest.permission_profile_sha256 && managed.current.version === op.manifest.version && !managed.pending) {
                op.phase = "started";
                if (op.explicit)
                    this.event(next, op.owner, `${op.id}:started`, `Bridge 已升级并启动：${this.options.currentVersion}。微信登录和待处理消息已保留；后续业务对话将按新版本建立会话。${state.attentionMcp.status === "ready" ? "Attention MCP 当前已连接。" : "Attention MCP 授权/连接仍需恢复，可发送「重试」。"}这不代表收藏摘要已补全。`);
            }
            else {
                op.phase = managed.status === "rolled_back" && managed.latestVersion === op.manifest.version ? "rolled_back" : "failed";
                next.quarantine.push(op.identity);
                next.lastErrorCode = op.phase === "rolled_back" ? "candidate_rolled_back" : "update_interrupted";
                this.event(next, op.owner, `${op.id}:interrupted`, op.phase === "rolled_back" ?
                    `Bridge ${op.manifest.version} 启动未通过，已回滚；实际运行 ${this.options.currentVersion}。该候选已暂停自动安装，可发送「检查更新」重新检查。` :
                    `上次 Bridge 升级在完成前中断，当前运行 ${this.options.currentVersion}；没有继续使用旧的升级确认。请发送「检查更新」。`);
            }
        }
        await this.commit(next);
    }
    private status(): string {
        const op = this.journal!.operation;
        const labels: Record<string, string> = { offered: "等待精确确认", approved: "已批准", downloading: "下载和校验中", waiting_safe_point: "等待出站消息发送完成", switching: "正在重启", started: "已启动", deferred: "已推迟", expired: "确认已失效", cancelled: "已取消", failed: "失败，旧版继续运行", rolled_back: "已回滚" };
        return `运行 Bridge：${this.options.currentVersion}（全局 CLI 单独升级）。${op ? `候选 ${op.manifest.version}：${labels[op.phase]}。` : "暂无升级操作。"}${this.journal!.lastErrorCode ? "最近检查/安装未完成；可发送「检查更新」。" : ""}可用：检查更新、升级状态、稍后升级、取消升级。`;
    }
    private async command(command: UpdateCommand, inboundId: string, owner: string): Promise<void> {
        const next = this.copy(), ref = updateDigest(["inbound", inboundId]);
        if (next.consumed.includes(ref))
            return;
        next.consumed.push(ref);
        const op = next.operation;
        let reply: string;
        let check = false;
        switch (command.kind) {
            case "status":
                reply = this.status();
                break;
            case "check":
                if (this.job || op && ACTIVE.has(op.phase))
                    reply = "升级检查或安装正在进行，可发送「升级状态」查看；不需要重复提交。";
                else if (next.lastManualCheckAt !== null && this.now() - next.lastManualCheckAt < 60000)
                    reply = "刚检查过更新，请稍后再试；「升级状态」可立即查看本地进度。";
                else {
                    next.lastManualCheckAt = this.now();
                    next.nextCheckAt = this.now() + 3600000;
                    check = true;
                    reply = "正在检查 Bridge 更新；这一步不会批准新增权限。";
                }
                break;
            case "confirm_help":
                reply = "请完整复制更新提示中的「确认升级 版本 确认码」；如果已过期，请发送「检查更新」。";
                break;
            case "confirm":
                if (!op || op.owner !== owner || op.phase !== "offered" || op.expiresAt <= this.now())
                    reply = "没有可使用的升级确认，或确认已过期。请发送「检查更新」。";
                else if (op.manifest.version !== command.version || op.codeHash !== updateDigest([op.id, command.code])) {
                    op.errors++;
                    if (op.errors >= 3)
                        op.phase = "expired";
                    reply = op.errors >= 3 ? "确认信息连续不匹配，本次确认已失效。请发送「检查更新」。" : "确认信息不匹配，请复制当前更新提示中的完整命令。";
                }
                else {
                    op.phase = "approved";
                    op.approvedUntil = this.now() + 30 * 60000;
                    reply = `已确认 Bridge ${op.manifest.version}。正在准备和校验安装包；切换前可发送「取消升级」，待处理消息会保留。`;
                }
                break;
            case "defer":
            case "cancel":
                if (op?.phase === "switching")
                    reply = "已经提交版本切换，正在重启；现在不能取消，也不会自动触发回滚。";
                else if (op && (op.phase === "offered" || ACTIVE.has(op.phase))) {
                    op.phase = command.kind === "defer" ? "deferred" : "cancelled";
                    this.abort?.abort();
                    this.prepared = null;
                    this.discardResult = !!this.job;
                    reply = "本次升级已撤销，当前版本继续运行；下载任务若尚未退出，会先停止并完成清理。需要时发送「检查更新」。";
                }
                else
                    reply = "当前没有可取消的升级操作。";
                break;
        }
        this.event(next, owner, `command:${ref}`, reply);
        await this.commit(next);
        if (check)
            this.startCheck(true);
    }
    private async acceptResult(owner: string): Promise<void> {
        const result = this.result;
        if (!result)
            return;
        this.result = null;
        this.job = null;
        this.abort = null;
        if (this.discardResult) {
            this.discardResult = false;
            return;
        }
        const next = this.copy();
        if (result.kind === "check") {
            const { manifest, changes, consent } = result.value;
            const identity = releaseIdentity(this.options.origin, manifest, this.options.currentVersion, this.options.currentPermissionProfileSha256);
            const old = next.operation;
            if (compareSemanticVersions(manifest.version, this.options.currentVersion) <= 0) {
                if (result.manual)
                    this.event(next, owner, `current:${next.lastManualCheckAt}`, `运行 Bridge ${this.options.currentVersion} 已是当前可用版本；不会降级。`);
            }
            else if (!result.manual && (old?.identity === identity || old?.phase === "deferred" && old.manifest.version === manifest.version || next.quarantine.includes(identity))) {
                // A deferred, failed, expired, or already offered candidate is never hourly-spammed.
            }
            else if (consent && changes === null) {
                const id = updateDigest([randomUUID(), identity, owner]);
                next.operation = { id, identity, owner, manifest, currentVersion: this.options.currentVersion, currentPermissionSha: this.options.currentPermissionProfileSha256,
                    phase: "deferred", explicit: true, codeHash: null, expiresAt: this.now(), approvedUntil: null, errors: 0 };
                this.event(next, owner, `${id}:unsupported`, `发现 Bridge ${manifest.version}，但其权限或运行要求无法由当前版本完整解释。微信确认不会放行未知权限、跨主版本或系统权限变化；需要在电脑端单独审查。当前 ${this.options.currentVersion} 继续运行。`);
            }
            else {
                const id = updateDigest([randomUUID(), identity, owner]);
                const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
                next.operation = { id, identity, owner, manifest, currentVersion: this.options.currentVersion, currentPermissionSha: this.options.currentPermissionProfileSha256,
                    phase: consent ? "offered" : "approved", explicit: consent || result.manual, codeHash: consent ? updateDigest([id, code]) : null, expiresAt: this.now() + 600000, approvedUntil: null, errors: 0 };
                next.lastErrorCode = null;
                if (consent) {
                    this.event(next, owner, `${id}:offer`, `发现 Bridge ${manifest.version}，当前 ${this.options.currentVersion}。\n${changes!.join("\n")}\n不开放 Shell、本地文件或其他 MCP。升级将短暂重连，保留微信登录及待处理消息。\n请回复：确认升级 ${manifest.version} ${code}\n10 分钟内有效；也可以回复「稍后升级」。`);
                    Object.assign(next.events.at(-1)!, { offerId: id, expiresAt: next.operation.expiresAt });
                }
            }
        }
        else if (result.kind === "prepare") {
            if (next.operation?.id === result.id && next.operation.phase === "downloading") {
                next.operation.phase = "waiting_safe_point";
                this.prepared = result.value;
                if (next.operation.explicit)
                    this.event(next, next.operation.owner, `${result.id}:starting`, `Bridge ${result.value.manifest.version} 安装包已校验；本条及已有回复送达后将短暂重启。微信登录和待处理消息会保留。`);
            }
        }
        else {
            if (result.id === null) {
                next.lastErrorCode = "update_check_failed";
                if (result.manual)
                    this.event(next, owner, `check-failed:${next.lastManualCheckAt}`, "暂时无法验证更新源或运行要求；没有安装任何版本，当前 Bridge 继续运行。稍后可发送「检查更新」。");
            }
            else if (next.operation?.id === result.id && next.operation.phase === "downloading") {
                next.operation.phase = "failed";
                next.quarantine.push(next.operation.identity);
                next.lastErrorCode = "candidate_preparation_failed";
                this.event(next, next.operation.owner, `${result.id}:failed`, "Bridge 安装包下载或安全校验未通过，旧版继续运行；没有改变权限或登录状态。可发送「检查更新」重新检查。");
            }
        }
        await this.commit(next);
    }
    private async notifications(state: ChannelState, persist: () => Promise<void>): Promise<void> {
        const next = this.copy();
        let changed = false;
        for (const event of next.events) {
            if (event.delivery === "delivered" || event.delivery === "superseded")
                continue;
            const id = `update-${event.id.slice(0, 32)}`;
            if (event.offerId && (event.offerId !== next.operation?.id || next.operation.phase !== "offered" || (event.expiresAt ?? 0) <= this.now())) {
                state.pendingOutbound = state.pendingOutbound.filter(e => e.id !== id);
                await persist();
                event.delivery = "superseded";
                changed = true;
                continue;
            }
            const owner = state.ownerUserId;
            if (!owner || ownerFingerprint(owner) !== event.owner)
                continue;
            const queued = state.pendingOutbound.some(e => e.id === id);
            if (event.delivery === "enqueued" && !queued) {
                event.delivery = "delivered";
                changed = true;
                continue;
            }
            if (event.delivery === "pending") {
                const contextToken = state.contextTokens[owner];
                if (!contextToken)
                    continue;
                enqueueOutbound(state, { id, contextToken, text: event.text, toUserId: owner });
                await persist(); // Cross-file ordering: outbox exists before journal says enqueued.
                event.delivery = "enqueued";
                changed = true;
            }
        }
        if (changed)
            await this.commit(next);
    }
    async tick(state: ChannelState, persist: () => Promise<void>): Promise<void> {
        if (!this.journal) {
            this.journal = await loadUpdateJournal(this.options.homeDirectory);
            await this.reconcile(state);
        }
        const owner = state.ownerUserId ? ownerFingerprint(state.ownerUserId) : null;
        if (!owner) {
            if (!this.job && this.now() >= this.journal.nextCheckAt) {
                const checking = this.copy();
                checking.nextCheckAt = this.now() + 3600000;
                await this.commit(checking);
                this.startCheck(false);
            }
            return;
        }
        const next = this.copy(), op = next.operation;
        if (op && ((op.owner !== owner && (op.phase === "offered" || ACTIVE.has(op.phase))) || (op.phase === "offered" && (op.expiresAt <= this.now() || op.identity !== releaseIdentity(this.options.origin, op.manifest, this.options.currentVersion, this.options.currentPermissionProfileSha256))) || (op.codeHash && ACTIVE.has(op.phase) && op.phase !== "switching" && (op.approvedUntil ?? 0) <= this.now()))) {
            op.phase = "expired";
            this.abort?.abort();
            this.prepared = null;
            await this.commit(next);
        }
        // Rotating, bounded scan. Controls behind a blocked business prefix still make progress.
        const inbox = state.pendingInbound, length = inbox.length, start = length ? this.scanOffset % length : 0;
        const batch = Array.from({ length: Math.min(length, 128) }, (_, i) => inbox[(start + i) % length]!);
        this.scanOffset = start + batch.length;
        let commands = 0;
        for (const pending of batch) {
            if (pending.message.fromUserId === state.ownerUserId && pending.message.contextToken)
                state.contextTokens[state.ownerUserId] = pending.message.contextToken;
            const command = matchUpdateCommand(pending.message, state.ownerUserId);
            if (!command || commands >= 8)
                continue;
            await this.command(command, pending.id, owner);
            completeInbound(state, pending.id);
            await persist();
            commands++;
        }
        await this.acceptResult(owner);
        const current = this.journal!;
        if (!this.job && current.operation?.phase === "approved") {
            const downloading = this.copy();
            downloading.operation!.phase = "downloading";
            await this.commit(downloading);
            this.startPreparation(downloading.operation!);
        }
        else if (!this.job && !this.pausesBusiness && this.now() >= current.nextCheckAt) {
            const checking = this.copy();
            checking.nextCheckAt = this.now() + 3600000;
            await this.commit(checking);
            this.startCheck(false);
        }
        await this.notifications(state, persist);
    }
    /** Invoked only by the serial service loop, after all active business and sends settle. */
    async activateIfSafe(state: ChannelState, persist: () => Promise<void>, idle: () => boolean = () => true, quiesce: () => Promise<void> = async () => {}): Promise<boolean> {
        if (this.restart)
            return true;
        await this.notifications(state, persist);
        const op = this.journal?.operation;
        if (!op || op.phase !== "waiting_safe_point" || !this.prepared || state.pendingOutbound.length || !idle() || state.runtimeState.activeTurnMessageRef)
            return false;
        if (this.journal!.events.some(e => e.owner === op.owner && e.delivery !== "delivered" && e.delivery !== "superseded"))
            return false;
        await quiesce();
        if (state.pendingOutbound.length || !idle() || state.runtimeState.activeTurnMessageRef) return false;
        const switching = this.copy();
        switching.operation!.phase = "switching";
        await this.commit(switching);
        try {
            await activateBridgeUpdate(this.options, this.prepared, () => idle() && state.pendingOutbound.length === 0 && (!op.codeHash || (op.approvedUntil ?? 0) > this.now()));
            this.restart = true;
            return true;
        }
        catch {
            // A post-rename I/O error cannot turn an already committed switch into a reported failure.
            const selected = await loadManagedBridgeUpdateState(this.options.homeDirectory);
            if (selected.current.artifactPath === this.prepared.candidatePath && selected.current.version === op.manifest.version && selected.current.permissionProfileSha256 === op.manifest.permission_profile_sha256 && selected.pending?.version === op.manifest.version) {
                this.restart = true;
                return true;
            }
            const failed = this.copy();
            failed.operation!.phase = "failed";
            failed.quarantine.push(op.identity);
            failed.lastErrorCode = "candidate_activation_failed";
            this.event(failed, op.owner, `${op.id}:activation-failed`, "升级切换前的复核未通过，当前进程继续运行；本次确认已停止。请发送「检查更新」。");
            await this.commit(failed);
            this.prepared = null;
            return false;
        }
    }
    async stop(): Promise<void> { this.abort?.abort(); await this.job; }
}
