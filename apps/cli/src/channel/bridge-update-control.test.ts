import { expect, it } from "vitest";
import { matchUpdateCommand } from "./bridge-update-control";
const msg = (text: string) => ({ fromUserId: "owner", contextToken: "ctx", raw: {}, itemList: [{ type: 1, text_item: { text } }] });
it("routes actual upgrade spellings without a model", () => {
  for (const text of ["升级", "升级 Bridge", "升级bridge", "升级brige"]) expect(matchUpdateCommand(msg(text), "owner")).toEqual({ kind: "upgrade" });
  expect(matchUpdateCommand(msg("检查更新"), "owner")).toEqual({ kind: "check" });
});
it("never authorizes upgrades from negation, quotations or another sender", () => {
  for (const text of ["不要升级", "升级全局 CLI", "他说升级", "`升级`", "升级了吗"]) expect(matchUpdateCommand(msg(text), "owner")).toBeNull();
  expect(matchUpdateCommand(msg("升级"), null)).toBeNull();
  expect(matchUpdateCommand(msg("升级"), "other")).toBeNull();
});
