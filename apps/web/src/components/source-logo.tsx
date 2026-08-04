import Image from "next/image";

import { GlobeIcon } from "./icons";

interface SourceBrand {
  asset: string;
  id: "bilibili" | "douyin" | "wechat" | "x" | "xiaohongshu" | "youtube";
}

function brandFor(source: string): SourceBrand | null {
  const value = source.trim().toLowerCase();

  if (value.includes("小红书") || value.includes("xiaohongshu") || value.includes("xhslink")) {
    return { asset: "/brands/xiaohongshu.svg", id: "xiaohongshu" };
  }
  if (
    value.includes("微信") ||
    value.includes("公众号") ||
    value.includes("wechat") ||
    value.includes("weixin.qq.com")
  ) {
    return { asset: "/brands/wechat.svg", id: "wechat" };
  }
  if (value.includes("抖音") || value.includes("douyin") || value.includes("tiktok")) {
    return { asset: "/brands/douyin.svg", id: "douyin" };
  }
  if (value.includes("哔哩") || value.includes("bilibili")) {
    return { asset: "/brands/bilibili.svg", id: "bilibili" };
  }
  if (value.includes("youtube") || value.includes("youtu.be")) {
    return { asset: "/brands/youtube.svg", id: "youtube" };
  }
  if (value === "x" || value === "x.com" || value.includes("twitter.com")) {
    return { asset: "/brands/x.svg", id: "x" };
  }

  return null;
}

export function SourceLogo({ source }: { source: string }) {
  const brand = brandFor(source);

  return (
    <span
      aria-label={`来源：${source}`}
      className={`source-brand source-brand--${brand?.id ?? "web"}`}
      role="img"
      title={source}
    >
      {brand ? (
        <Image alt="" aria-hidden="true" height={24} src={brand.asset} width={24} />
      ) : (
        <>
          <GlobeIcon aria-hidden="true" />
          <span className="source-brand__fallback-label">{source}</span>
        </>
      )}
    </span>
  );
}
