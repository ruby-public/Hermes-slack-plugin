(function () {
  const PLUGIN_NAME = "ruby-slack-support";
  const SDK = window.__HERMES_PLUGIN_SDK__ || {};
  const React = SDK.React || window.React;

  if (!React) {
    console.error("[ruby-slack-support] React is not available from the Hermes plugin SDK.");
    return;
  }

  const h = React.createElement;
  const {useCallback, useEffect, useMemo, useRef, useState} = React;

  function getQueryTaskId() {
    return new URLSearchParams(window.location.search).get("task_id") || "";
  }

  function formatDetail(error) {
    const detail = error && error.detail ? error.detail : error;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      return detail.message || detail.code || JSON.stringify(detail);
    }
    return "Unknown error";
  }

  async function apiFetch(path, options) {
    const url = `/api/plugins/${PLUGIN_NAME}${path}`;
    if (SDK.fetchJSON) return SDK.fetchJSON(url, options);

    const fetcher = SDK.authedFetch || window.fetch.bind(window);
    const response = await fetcher(url, options);
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(formatDetail(body));
      error.detail = body && body.detail ? body.detail : body;
      throw error;
    }
    return body;
  }

  function buildMeta(task) {
    if (!task) return [];
    return [
      ["Task", task.task_id],
      ["Scope", [task.brand, task.site, task.language].filter(Boolean).join(" / ")],
      ["Status", task.status],
      ["Reason", task.reason],
      ["Confidence", typeof task.confidence === "number" ? task.confidence.toFixed(2) : task.confidence],
      ["Knowledge", task.knowledge_state],
    ].filter((item) => item[1] !== undefined && item[1] !== null && item[1] !== "");
  }

  function Field({label, value, multiline}) {
    const safeValue = value === undefined || value === null ? "" : String(value);
    return h(
      "label",
      {className: "rss-field"},
      h("span", {className: "rss-field-label"}, label),
      multiline
        ? h("textarea", {
            value: safeValue,
            readOnly: true,
            rows: 7,
            className: "rss-textarea",
          })
        : h("input", {
            value: safeValue,
            readOnly: true,
            className: "rss-input",
          }),
    );
  }

  function Button({children, kind = "secondary", disabled, onClick, href}) {
    const props = {
      className: `rss-button rss-button-${kind}`,
      disabled,
      onClick,
    };
    if (href) {
      props.href = href;
      props.target = "_blank";
      props.rel = "noreferrer";
      delete props.disabled;
      return h("a", props, children);
    }
    return h("button", props, children);
  }

  function Chip({children, tone = "neutral"}) {
    return h("span", {className: `rss-chip rss-chip-${tone}`}, children);
  }

  function ConfigBanner({config}) {
    if (!config) return null;
    if (config.configured) {
      return h(
        "div",
        {className: "rss-banner rss-banner-ok"},
        h("span", null, "Connected"),
        h("code", null, config.api_base_url || "support Worker"),
      );
    }
    return h(
      "div",
      {className: "rss-banner rss-banner-warn"},
      h("span", null, "Missing local config"),
      h("code", null, (config.missing || []).join(", ") || "unknown"),
    );
  }

  function App() {
    const [config, setConfig] = useState(null);
    const [taskId, setTaskId] = useState(getQueryTaskId);
    const [taskData, setTaskData] = useState(null);
    const [queue, setQueue] = useState([]);
    const [filters, setFilters] = useState({brand: "", site: "", language: "ko", status: "open", limit: "20"});
    const [loadingTask, setLoadingTask] = useState(false);
    const [loadingQueue, setLoadingQueue] = useState(false);
    const [error, setError] = useState("");
    const [sessionId, setSessionId] = useState("");
    const [runLines, setRunLines] = useState([]);
    const wsRef = useRef(null);

    const task = taskData && taskData.task ? taskData.task : null;
    const prompt = taskData && taskData.prompt ? taskData.prompt : "";
    const meta = useMemo(() => buildMeta(task), [task]);
    const context = task && task.context && typeof task.context === "object" ? task.context : {};

    const appendRunLine = useCallback((line) => {
      setRunLines((current) => [line, ...current].slice(0, 10));
    }, []);

    const loadConfig = useCallback(async () => {
      try {
        const nextConfig = await apiFetch("/config");
        setConfig(nextConfig);
        if (nextConfig && nextConfig.defaults) {
          setFilters((current) => ({
            ...current,
            brand: current.brand || nextConfig.defaults.brand || "",
            site: current.site || nextConfig.defaults.site || "",
            language: current.language || nextConfig.defaults.language || "ko",
          }));
        }
      } catch (nextError) {
        setError(formatDetail(nextError));
      }
    }, []);

    const loadTask = useCallback(async (id) => {
      const cleanId = (id || "").trim();
      if (!cleanId) return;
      setLoadingTask(true);
      setError("");
      try {
        const response = await apiFetch(`/handoffs/${encodeURIComponent(cleanId)}`);
        setTaskData(response);
        setTaskId(cleanId);
      } catch (nextError) {
        setError(formatDetail(nextError));
      } finally {
        setLoadingTask(false);
      }
    }, []);

    const loadQueue = useCallback(async () => {
      setLoadingQueue(true);
      setError("");
      try {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
          if (value) query.set(key, value);
        }
        const response = await apiFetch(`/handoffs?${query.toString()}`);
        setQueue(response.tasks || []);
      } catch (nextError) {
        setError(formatDetail(nextError));
      } finally {
        setLoadingQueue(false);
      }
    }, [filters]);

    const selectTask = useCallback(
      (id) => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("task_id", id);
        window.history.replaceState(null, "", nextUrl.toString());
        loadTask(id);
      },
      [loadTask],
    );

    const copyPrompt = useCallback(async () => {
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      appendRunLine("Prompt copied to clipboard.");
    }, [appendRunLine, prompt]);

    const startHermesSession = useCallback(async () => {
      if (!prompt) return;
      setError("");
      setSessionId("");
      setRunLines(["Connecting to local Hermes gateway..."]);

      try {
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }

        if (!SDK.buildWsUrl) {
          throw new Error("Hermes plugin SDK did not expose buildWsUrl.");
        }

        const wsUrl = await SDK.buildWsUrl("/api/ws");
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        let nextId = 1;
        const pending = new Map();

        ws.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (_error) {
            appendRunLine("Gateway event: non-JSON message");
            return;
          }

          if (message.id && pending.has(String(message.id))) {
            const callbacks = pending.get(String(message.id));
            pending.delete(String(message.id));
            if (message.error) callbacks.reject(message.error);
            else callbacks.resolve(message.result);
            return;
          }

          const label = message.method || message.type || "gateway event";
          appendRunLine(label);
        };

        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error("Could not connect to the local Hermes gateway."));
        });

        function call(method, params) {
          const id = String(nextId++);
          ws.send(JSON.stringify({jsonrpc: "2.0", id, method, params}));
          return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject});
            window.setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              reject(new Error(`${method} timed out`));
            }, 20000);
          });
        }

        appendRunLine("Creating Hermes session...");
        const created = await call("session.create", {cols: 96, rows: 30});
        const createdSessionId =
          (created && created.session_id) ||
          (created && created.id) ||
          (created && created.session && created.session.id);
        if (!createdSessionId) {
          throw new Error("Hermes did not return a session id.");
        }

        appendRunLine("Submitting handoff prompt...");
        await call("prompt.submit", {session_id: createdSessionId, text: prompt});
        setSessionId(createdSessionId);
        appendRunLine(`Submitted to session ${createdSessionId}.`);
      } catch (nextError) {
        setError(formatDetail(nextError));
        appendRunLine(`Failed: ${formatDetail(nextError)}`);
      }
    }, [appendRunLine, prompt]);

    useEffect(() => {
      loadConfig();
      const initialTaskId = getQueryTaskId();
      if (initialTaskId) loadTask(initialTaskId);
      return () => {
        if (wsRef.current) wsRef.current.close();
      };
    }, [loadConfig, loadTask]);

    return h(
      "div",
      {className: "rss-root"},
      h(
        "div",
        {className: "rss-header"},
        h("div", null, h("h1", null, "Ruby Support"), h("p", null, "Slack handoff workstation")),
        h(ConfigBanner, {config}),
      ),
      error ? h("div", {className: "rss-error"}, error) : null,
      h(
        "section",
        {className: "rss-panel rss-task-loader"},
        h("div", {className: "rss-inline-field"}, h("span", null, "Task ID"), h("input", {
          className: "rss-input",
          value: taskId,
          onChange: (event) => setTaskId(event.target.value),
          placeholder: "support handoff task id",
        })),
        h(Button, {kind: "primary", disabled: loadingTask || !taskId.trim(), onClick: () => loadTask(taskId)}, loadingTask ? "Loading" : "Load"),
      ),
      task
        ? h(
            "section",
            {className: "rss-panel"},
            h(
              "div",
              {className: "rss-section-head"},
              h("h2", null, "Handoff"),
              h(
                "div",
                {className: "rss-actions"},
                context.conversation_url
                  ? h(Button, {href: context.conversation_url}, "Open Chatwoot")
                  : null,
                h(Button, {onClick: copyPrompt}, "Copy prompt"),
                h(Button, {kind: "primary", onClick: startHermesSession}, "Start Hermes"),
              ),
            ),
            h("div", {className: "rss-meta"}, meta.map(([label, value]) => h(Chip, {key: label}, `${label}: ${value}`))),
            task.risk_flags && task.risk_flags.length
              ? h("div", {className: "rss-risk"}, task.risk_flags.map((flag) => h(Chip, {key: flag, tone: "risk"}, flag)))
              : null,
            h("div", {className: "rss-grid"}, h(Field, {label: "Customer message", value: task.user_message || "", multiline: true}), h(Field, {label: "Suggested reply", value: task.suggested_reply || "", multiline: true})),
            h(Field, {label: "Prompt preview", value: prompt, multiline: true}),
            sessionId ? h("div", {className: "rss-session"}, "Session: ", h("code", null, sessionId)) : null,
            runLines.length
              ? h("div", {className: "rss-log"}, runLines.map((line, index) => h("div", {key: `${line}-${index}`}, line)))
              : null,
          )
        : null,
      h(
        "section",
        {className: "rss-panel"},
        h(
          "div",
          {className: "rss-section-head"},
          h("h2", null, "Queue"),
          h(Button, {disabled: loadingQueue, onClick: loadQueue}, loadingQueue ? "Loading" : "Refresh"),
        ),
        h(
          "div",
          {className: "rss-filters"},
          ["brand", "site", "language", "status", "limit"].map((key) =>
            h("label", {key, className: "rss-filter"}, h("span", null, key), h("input", {
              className: "rss-input",
              value: filters[key],
              onChange: (event) => setFilters((current) => ({...current, [key]: event.target.value})),
            })),
          ),
        ),
        queue.length
          ? h(
              "div",
              {className: "rss-list"},
              queue.map((item) =>
                h(
                  "button",
                  {
                    key: item.task_id,
                    className: "rss-row",
                    onClick: () => selectTask(item.task_id),
                  },
                  h("span", {className: "rss-row-main"}, item.user_message || item.task_id),
                  h("span", {className: "rss-row-sub"}, `${item.reason || "handoff"} · ${item.created_at || ""}`),
                ),
              ),
            )
          : h("div", {className: "rss-empty"}, "No handoffs loaded."),
      ),
    );
  }

  if (window.__HERMES_PLUGINS__ && window.__HERMES_PLUGINS__.register) {
    window.__HERMES_PLUGINS__.register(PLUGIN_NAME, App);
  } else if (SDK.registerPlugin) {
    SDK.registerPlugin(PLUGIN_NAME, App);
  } else {
    console.error("[ruby-slack-support] Hermes plugin registry is not available.");
  }
})();
