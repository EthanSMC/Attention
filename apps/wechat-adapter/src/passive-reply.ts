import { serializeWechatXml } from "./xml.js";
import { truncateUtf8 } from "./text.js";

export function passiveTextReply(input: {
  createTime: number;
  fromUser: string;
  text: string;
  toUser: string;
}): string {
  return serializeWechatXml({
    Content: truncateUtf8(input.text, 1_900),
    CreateTime: input.createTime,
    FromUserName: input.fromUser,
    MsgType: "text",
    ToUserName: input.toUser,
  });
}
