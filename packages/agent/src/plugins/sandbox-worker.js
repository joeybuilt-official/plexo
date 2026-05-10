// packages/agent/src/plugins/sandbox-worker.ts
import { parentPort, workerData } from "worker_threads";
import { randomUUID } from "node:crypto";
import { createContext, Script } from "node:vm";
import { readFileSync } from "node:fs";

// packages/agent/src/plugins/activation-sdk.ts
var nullBridge = async (method) => {
  throw new Error(`Host bridge not configured \u2014 ${method} unavailable in this context`);
};
function createActivationSDK(extensionName, capabilities, settings, workspaceId, bridge = nullBridge) {
  const capSet = new Set(capabilities);
  capSet.add("tools:register");
  const registered = { tools: [], schedules: [], widgets: [] };
  function requireCap(token) {
    if (!capSet.has(token)) {
      throw new Error(`CAPABILITY_DENIED: tool "${extensionName}" requires "${token}" capability`);
    }
  }
  function hasMemoryCap(action) {
    const unscoped = `memory:${action}`;
    if (capSet.has(unscoped))
      return;
    const entityScoped = [...capSet].some((c) => c.startsWith(`memory:${action}:`));
    if (entityScoped)
      return;
    throw new Error(`CAPABILITY_DENIED: tool "${extensionName}" requires a "memory:${action}" capability (unscoped or entity-scoped)`);
  }
  const sdk = {
    host: {
      pexVersion: "0.3.0",
      complianceLevel: "full",
      name: "plexo",
      version: process.env.npm_package_version ?? "0.0.0"
    },
    registerTool(tool) {
      requireCap("tools:register");
      registered.tools.push(tool);
    },
    registerSchedule(job) {
      requireCap("schedule:register");
      registered.schedules.push(job);
    },
    registerWidget(widget) {
      requireCap("ui:register-widget");
      registered.widgets.push(widget);
    },
    registerPrompt(prompt) {
      requireCap("prompts:register");
      void bridge("prompts.register", {
        workspaceId,
        extensionName,
        promptId: prompt.id,
        name: prompt.name,
        description: prompt.description ?? "",
        template: prompt.template,
        variables: prompt.variables ?? [],
        tags: prompt.tags ?? [],
        version: prompt.version,
        priority: prompt.priority ?? "normal",
        dependencies: prompt.dependencies ?? []
      });
    },
    registerContext(context) {
      requireCap("context:register");
      void bridge("context.register", {
        workspaceId,
        extensionName,
        contextId: context.id,
        name: context.name,
        description: context.description ?? "",
        content: context.content,
        contentType: context.contentType ?? "text/plain",
        priority: context.priority ?? "normal",
        ttl: context.ttl,
        tags: context.tags ?? [],
        estimatedTokens: context.estimatedTokens
      });
    },
    prompts: {
      async list() {
        requireCap("prompts:read");
        return bridge("prompts.list", { workspaceId, extensionName });
      },
      async resolve(promptId, variables) {
        requireCap("prompts:read");
        return bridge("prompts.resolve", { workspaceId, extensionName, promptId, variables: variables ?? {} });
      }
    },
    context: {
      async update(contextId, content, opts) {
        requireCap("context:write");
        await bridge("context.update", {
          workspaceId,
          extensionName,
          contextId,
          content,
          ttl: opts?.ttl,
          estimatedTokens: opts?.estimatedTokens
        });
      },
      async list() {
        requireCap("context:read");
        return bridge("context.list", { workspaceId, extensionName });
      }
    },
    memory: {
      async read(query, opts) {
        hasMemoryCap("read");
        return bridge("memory.read", {
          workspaceId,
          query,
          tags: opts?.tags,
          limit: opts?.limit
        });
      },
      async write(entry) {
        hasMemoryCap("write");
        return bridge("memory.write", {
          workspaceId,
          content: entry.content,
          tags: entry.tags,
          metadata: { ...entry.metadata, authorExtension: extensionName },
          ttl: entry.ttl
        });
      },
      async delete(id) {
        hasMemoryCap("delete");
        await bridge("memory.delete", { workspaceId, id });
      }
    },
    connections: {
      async getCredentials(service) {
        requireCap(`connections:${service}`);
        return bridge("connections.getCredentials", { workspaceId, service });
      },
      async isConnected(service) {
        requireCap(`connections:${service}`);
        const result = await bridge("connections.isConnected", { workspaceId, service });
        return Boolean(result);
      }
    },
    channel: {
      async send(_msg) {
        requireCap("channel:send");
        await bridge("channel.send", { workspaceId, msg: _msg });
      },
      async sendDirect(_channelId, _msg) {
        requireCap("channel:send-direct");
        await bridge("channel.sendDirect", { workspaceId, channelId: _channelId, msg: _msg });
      }
    },
    tasks: {
      async create(opts) {
        requireCap("tasks:create");
        return bridge("tasks.create", { workspaceId, opts });
      },
      async get(id) {
        requireCap("tasks:read");
        return bridge("tasks.get", { workspaceId, id });
      },
      async list(filter) {
        requireCap("tasks:read");
        return bridge("tasks.list", { workspaceId, filter });
      }
    },
    events: {
      subscribe(_topic, _handler) {
        requireCap("events:subscribe");
      },
      async publish(topic, payload) {
        requireCap("events:publish");
        const scope = extensionName.replace(/^@/, "").replace("/", "_");
        if (!topic.startsWith(`ext.${scope}.`)) {
          throw new Error(`CAPABILITY_DENIED: tool may only publish to ext.${scope}.* namespace`);
        }
        await bridge("events.publish", { topic, payload, extensionName });
      }
    },
    storage: {
      async get(key) {
        requireCap("storage:read");
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
          return settings[key];
        }
        const result = await bridge("storage.get", { extensionName, key });
        return result;
      },
      async set(key, value, opts) {
        requireCap("storage:write");
        await bridge("storage.set", { extensionName, key, value, ttl: opts?.ttlSeconds });
      },
      async delete(key) {
        requireCap("storage:write");
        await bridge("storage.delete", { extensionName, key });
      }
    },
    ui: {
      async notify(msg, level) {
        requireCap("ui:notify");
        await bridge("ui.notify", { workspaceId, msg, level });
      }
    },
    // §16 — Personal Entity Resolution
    entities: {
      async resolve(type, id) {
        hasMemoryCap("read");
        return bridge("entities.resolve", { workspaceId, type, id });
      },
      async search(type, query) {
        hasMemoryCap("read");
        return bridge("entities.search", { workspaceId, type, query });
      },
      async create(type, data) {
        requireCap(`entity:create:${type}`);
        return bridge("entities.create", { workspaceId, type, data });
      },
      async link(source, target) {
        requireCap(`entity:modify:${source.type}`);
        await bridge("entities.link", { workspaceId, source, target });
      }
    },
    // §20 — Persistent UserSelf
    self: {
      async read(fields) {
        requireCap("self:read");
        return bridge("self.read", { fields });
      },
      async propose(proposal) {
        requireCap("self:write");
        await bridge("self.propose", { proposal });
      }
    },
    // §18 — Audit Trail (owner tier only)
    audit: {
      async query(query) {
        requireCap("audit:read");
        return bridge("audit.query", { workspaceId, query });
      }
    },
    // §23 — Escalation Contract
    async escalate(request) {
      return bridge("escalate", { workspaceId, extensionName, request });
    },
    // §22 — A2A Bridge Layer
    a2a: {
      async discover(endpoint) {
        requireCap("a2a:delegate");
        return bridge("a2a.discover", { endpoint });
      },
      async delegate(delegation) {
        requireCap("a2a:delegate");
        return bridge("a2a.delegate", { workspaceId, extensionName, delegation });
      }
    }
  };
  return { sdk, getResult: () => ({ ...registered }) };
}

// packages/agent/src/plugins/sandbox-worker.ts
var _bridgePending = /* @__PURE__ */ new Map();
function makeMessageBridge() {
  return async (method, args) => {
    if (!parentPort)
      throw new Error("No parentPort \u2014 bridge unavailable");
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      _bridgePending.set(callId, { resolve, reject });
      parentPort.postMessage({ type: "sdk_call", callId, method, args });
    });
  };
}
var _registeredTools = [];
var _input = null;
function reply(msg) {
  parentPort?.postMessage(msg);
}
async function loadExtensionInSandbox(entry, sdk) {
  try {
    const code = readFileSync(entry, "utf-8");
    const sandbox = createContext({
      console: Object.freeze({
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: () => {
        }
      }),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: globalThis.fetch,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      JSON,
      Math,
      Date,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      TypeError,
      RangeError,
      // Module-like exports object for the extension to populate
      __exports: {}
    });
    const wrappedCode = code.replace(/^export\s+async\s+function\s+(\w+)/gm, "__exports.$1 = async function $1").replace(/^export\s+function\s+(\w+)/gm, "__exports.$1 = function $1").replace(/^export\s+const\s+(\w+)\s*=/gm, "__exports.$1 =").replace(/^export\s+let\s+(\w+)\s*=/gm, "__exports.$1 =").replace(/^export\s+default\s+/gm, "__exports.default = ");
    const script = new Script(wrappedCode, { filename: entry });
    script.runInContext(sandbox, { timeout: 5e3 });
    return sandbox.__exports;
  } catch {
    return await import(entry);
  }
}
async function handleActivate(msg) {
  _input = msg.input;
  try {
    const { sdk, getResult } = createActivationSDK(
      msg.input.pluginName,
      msg.input.permissions,
      msg.input.settings,
      msg.input.workspaceId ?? "sandbox",
      makeMessageBridge()
    );
    const extModule = await loadExtensionInSandbox(msg.input.entry, sdk);
    if (typeof extModule.activate !== "function") {
      reply({ type: "error", callId: msg.callId, error: `Tool "${msg.input.pluginName}" does not export activate()` });
      return;
    }
    await extModule.activate(sdk);
    const { tools, schedules, widgets } = getResult();
    _registeredTools = tools;
    reply({
      type: "activated",
      callId: msg.callId,
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, hints: t.hints })),
      schedules: schedules.map((s) => ({ name: s.name, schedule: s.schedule })),
      widgets: widgets.map((w) => ({ name: w.name, displayName: w.displayName, displayType: w.displayType }))
    });
  } catch (err) {
    reply({ type: "error", callId: msg.callId, error: err instanceof Error ? err.message : String(err) });
  }
}
async function handleInvoke(msg) {
  const toolDef = _registeredTools.find((t) => t.name === msg.toolName);
  if (!toolDef) {
    reply({ type: "error", callId: msg.callId, error: `Tool "${msg.toolName}" not registered in "${_input?.pluginName}"` });
    return;
  }
  try {
    const result = await toolDef.handler(msg.args, {
      workspaceId: msg.workspaceId,
      requestId: randomUUID()
    });
    reply({ type: "result", callId: msg.callId, result });
  } catch (err) {
    reply({ type: "error", callId: msg.callId, error: err instanceof Error ? err.message : String(err) });
  }
}
function handleBridgeReply(msg) {
  const pending = _bridgePending.get(msg.callId);
  if (!pending)
    return;
  _bridgePending.delete(msg.callId);
  if (msg.error) {
    pending.reject(new Error(msg.error));
  } else {
    pending.resolve(msg.result);
  }
}
if (parentPort) {
  parentPort.on("message", (msg) => {
    if (msg.type === "activate") {
      void handleActivate(msg);
    } else if (msg.type === "invoke") {
      void handleInvoke(msg);
    } else if (msg.type === "bridge_reply") {
      handleBridgeReply(msg);
    } else if (msg.type === "terminate") {
      process.exit(0);
    }
  });
} else if (workerData) {
  void (async () => {
    const { parentPort: port } = await import("worker_threads");
    const input = workerData;
    const { sdk, getResult } = createActivationSDK(input.pluginName, input.permissions, input.settings, input.workspaceId ?? "sandbox");
    const extModule = await loadExtensionInSandbox(input.entry, sdk);
    if (typeof extModule.activate === "function")
      await extModule.activate(sdk);
    const { tools } = getResult();
    if (input.toolName === "__activate__") {
      port?.postMessage({ ok: true, result: { registeredTools: tools } });
    } else {
      const toolDef = tools.find((t) => t.name === input.toolName);
      if (toolDef) {
        const result = await toolDef.handler(input.args, { workspaceId: input.workspaceId ?? "sandbox", requestId: randomUUID() });
        port?.postMessage({ ok: true, result });
      } else {
        port?.postMessage({ ok: false, error: `Tool "${input.toolName}" not found` });
      }
    }
  })();
}
