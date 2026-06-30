// SDK + Zod resolution.
//
// These are declared dependencies of this package, so a plain import resolves
// them from node_modules. The bundled `claude` binary that the SDK spawns is
// what actually performs OAuth (reading the credentials for the profile named
// by CLAUDE_CONFIG_DIR); see src/auth.mjs.
//
// zod must be the SAME major the SDK bundles (v4), because we call
// z.fromJSONSchema, which only exists in zod v4. The SDK depends on zod@^4, so
// importing "zod" here resolves to a compatible v4.

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const { query, createSdkMcpServer } = sdk;
export { z };
