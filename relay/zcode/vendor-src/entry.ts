// vendor bundle 入口：从官方开源仓（third_party/zcode，Apache-2.0）提取
// companion 桥接 app-server 所需的最小契约面。构建产物
// relay/zcode/vendor/zcode-protocol.cjs 提交入库，运行时不依赖 submodule。
// 升级流程见 scripts/build-zcode-protocol.mjs 头注。
export {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  ZCODE_PROTOCOL_V4_WIRE_VERSION,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProtocolErrorCodes,
  zcodeProtocolRequestSchema,
  zcodeProtocolNotificationSchema,
  zcodeProtocolResponseSchema,
  zcodeProtocolErrorSchema,
  zcodeProtocolMessageSchema,
  zcodeProtocolRequestIdSchema,
  zcodeProtocolTraceSchema,
  zcodeStoragePathReadySchema,
  zcodeStorageStartupStateSchema,
  databaseStartupErrorCodeSchema,
  zcodePermissionDecisionSchema,
  zcodePermissionResponseSchema,
  zcodePermissionUpdateSchema,
  zcodeSessionModeSchema,
  zcodeSessionStatusSchema,
  zcodeSessionKindSchema,
  zcodeSessionApiRetryStatusSchema,
  zcodeMessagePartSchema,
  zcodeMessageWithPartsSchema,
  zcodeSessionInfoSchema,
  zcodeSessionRuntimeStateSchema,
  zcodeSessionContextUsageSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeProtocolEmptyResultSchema,
} from "@zcode/shared";

export {
  ZCodeProtocolClient,
  ZCodeProtocolRequestTimeoutError,
} from "#src/zcode-agent/zcodeProtocolClient.js";
export { ZCodeStorageStartupGate } from "#src/zcode-agent/zcodeStorageStartupGate.js";
