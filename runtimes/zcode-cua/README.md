# @zcode/zcode-cua

Computer Use runtime for ZCode: permission-broker wire client and server
(NDJSON, IPC v2, authenticate handshake), the tool-call runtime
(`createComputerUseRuntime`), Helper install/launch/verify and lifecycle
management, the PiP session client, and the frame-integrity contracts
(image_ref pairing, `zcode.cua/official-frame-integrity-v1`).

Layout:

- `index.js` — `createComputerUseRuntime` entry point.
- `vendor/dist-index.js` — bundled runtime slice (single ES module).
- `broker.js` — wire protocol (`parseRequestLine`, `okResponse`,
  `errorResponse`, `dispatchRequest`, `handleRequestLine`), socket-path
  helpers, `callBrokerMethod`, `probeHelperHealth`, error factories.
- `broker-server.js` — Helper constants, launcher/installer plumbing,
  lifecycle manager, permission-refresh marker, product MCP server resolver.
- `broker-ports.js` — renderer-safe pure predicates (no `node:` imports).
- `frame-contract.js` / `host-display-contract.js` /
  `request-access-contract.js` — producer/host contract helpers.
- `pip-session.js` — shared PiP event types; `pip-session-node.js` — the
  Node presentation-role client (`pip_session_handshake` /
  `pip_session_event`, protocol v2).

When no Helper/broker is running, tool calls return the structured
`CUA_NOT_READY` envelope (`broker_not_accepting`, retryable) rather than a
hard error.

License: Apache-2.0.
