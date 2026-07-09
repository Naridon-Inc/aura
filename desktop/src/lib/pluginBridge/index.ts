// Public entrypoint for the plugin bridge. Lib consumers (NavRail tile
// renderer, RightRail panel renderer, slash-command dispatcher) only
// reach for these symbols.

export {
  BRIDGE_PROTOCOL_VERSION,
  ErrorCode,
  isPluginEnvelope,
  type PluginCallEnvelope,
  type PluginEnvelope,
  type PluginError,
  type PluginEventEnvelope,
  type PluginHandshakeEnvelope,
  type PluginResultEnvelope,
} from "./protocol";

export {
  CapabilitySet,
  globMatch,
  parseCapability,
  type Capability,
  type CapabilityError,
} from "./capability";

export {
  MethodRouter,
  PluginBridge,
  type BridgeTransport,
  type HostCallContext,
  type HostMethod,
  type PluginBridgeOptions,
} from "./host";

export {
  createIframeTransport,
  createMemoryTransport,
  createWorkerTransport,
  type IframeTransportOptions,
  type MemoryTransportPair,
} from "./transports";
