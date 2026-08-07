import "server-only";

import type { NextResponse } from "next/server";

import { noStoreJson } from "./api-guard";

export const DISABLED_CHANNEL_ENTRY_RESPONSE = {
  error: {
    code: "hosted_channel_not_available",
    message:
      "This product entry is not available in the infrastructure-only release.",
  },
  release_scope: "local_agent_infrastructure",
} as const;

export function disabledChannelEntryResponse(): NextResponse {
  return noStoreJson(DISABLED_CHANNEL_ENTRY_RESPONSE, { status: 410 });
}
