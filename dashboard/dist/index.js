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
      if (detail.message) return detail.message;
      if (detail.code) return detail.code;
      if (detail.body && typeof detail.body === "object") return detail.body.message || detail.body.code || JSON.stringify(detail.body);
      return JSON.stringify(detail);
    }
    return "Unknown error";
  }

  function safeValue(value) {
    return value === undefined || value === null ? "" : String(value);
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

  function taskContext(task) {
    return task && task.context && typeof task.context === "object" ? task.context : {};
  }

  function taskMeta(task) {
    if (!task) return [];
    return [
      ["Task", task.task_id],
      ["Scope", [task.brand, task.site, task.language].filter(Boolean).join(" / ")],
      ["Status", task.status],
      ["Assigned", task.assigned_to],
      ["Reason", task.reason],
      ["Confidence", typeof task.confidence === "number" ? task.confidence.toFixed(2) : task.confidence],
      ["Knowledge", task.knowledge_state],
      ["Created", task.created_at],
    ].filter((item) => item[1] !== undefined && item[1] !== null && item[1] !== "");
  }

  function Button({children, kind = "secondary", disabled, onClick, href, title}) {
    const props = {
      className: `rss-button rss-button-${kind}`,
      disabled,
      onClick,
      title,
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

  function Field({label, value, multiline}) {
    return h(
      "label",
      {className: "rss-field"},
      h("span", {className: "rss-field-label"}, label),
      multiline
        ? h("textarea", {value: safeValue(value), readOnly: true, rows: 7, className: "rss-textarea"})
        : h("input", {value: safeValue(value), readOnly: true, className: "rss-input"}),
    );
  }

  function ConfigBanner({config}) {
    if (!config) return null;
    if (config.configured) {
      return h(
        "div",
        {className: "rss-banner rss-banner-ok"},
        h("span", null, "Worker connected"),
        h("code", null, config.api_base_url || "support Worker"),
      );
    }
    return h(
      "div",
      {className: "rss-banner rss-banner-warn"},
      h("span", null, "Missing config"),
      h("code", null, (config.missing || []).join(", ") || "unknown"),
    );
  }

  function QueueRow({task, selected, isNew, onSelect}) {
    const context = taskContext(task);
    const tone = task.status === "open" ? "open" : task.status === "claimed" ? "claimed" : "neutral";
    return h(
      "button",
      {
        className: ["rss-row", selected ? "rss-row-selected" : "", isNew ? "rss-row-new" : ""].filter(Boolean).join(" "),
        onClick: () => onSelect(task.task_id),
      },
      h(
        "span",
        {className: "rss-row-top"},
        h(Chip, {tone}, task.status || "open"),
        task.assigned_to ? h("span", {className: "rss-row-assignee"}, task.assigned_to) : h("span", {className: "rss-row-assignee"}, "unassigned"),
      ),
      h("span", {className: "rss-row-main"}, task.user_message || task.task_id),
      h("span", {className: "rss-row-sub"}, `${task.reason || "handoff"} · ${context.customer_account || task.conversation_id || ""} · ${task.created_at || ""}`),
    );
  }

  function App() {
    const [config, setConfig] = useState(null);
    const [filters, setFilters] = useState({brand: "", site: "", language: "ko", status: "active", limit: "30"});
    const [queue, setQueue] = useState([]);
    const [selectedId, setSelectedId] = useState(getQueryTaskId);
    const [taskData, setTaskData] = useState(null);
    const [pollEnabled, setPollEnabled] = useState(true);
    const [alertsEnabled, setAlertsEnabled] = useState(false);
    const [loadingQueue, setLoadingQueue] = useState(false);
    const [loadingTask, setLoadingTask] = useState(false);
    const [actionBusy, setActionBusy] = useState("");
    const [error, setError] = useState("");
    const [lastRefresh, setLastRefresh] = useState("");
    const [newTaskIds, setNewTaskIds] = useState([]);
    const [sessionId, setSessionId] = useState("");
    const [runLines, setRunLines] = useState([]);
    const seenIdsRef = useRef(new Set());
    const wsRef = useRef(null);

    const task = taskData && taskData.task ? taskData.task : null;
    const prompt = taskData && taskData.prompt ? taskData.prompt : "";
    const context = taskContext(task);
    const openCount = queue.filter((item) => item.status === "open").length;
    const claimedCount = queue.filter((item) => item.status === "claimed").length;
    const pollMs = 15000;

    const appendRunLine = useCallback((line) => {
      setRunLines((current) => [line, ...current].slice(0, 12));
    }, []);

    const updateUrlTaskId = useCallback((id) => {
      const nextUrl = new URL(window.location.href);
      if (id) nextUrl.searchParams.set("task_id", id);
      else nextUrl.searchParams.delete("task_id");
      window.history.replaceState(null, "", nextUrl.toString());
    }, []);

    const notifyNewTasks = useCallback(
      (items) => {
        if (!items.length) return;
        const ids = items.map((item) => item.task_id).filter(Boolean);
        setNewTaskIds(ids);
        window.setTimeout(() => {
          setNewTaskIds((current) => current.filter((id) => !ids.includes(id)));
        }, 45000);

        if (alertsEnabled && "Notification" in window && Notification.permission === "granted") {
          const first = items[0];
          new Notification(`${items.length} new support handoff${items.length > 1 ? "s" : ""}`, {
            body: first.user_message || first.reason || "Open Ruby Support",
            tag: "ruby-slack-support-handoff",
          });
        }
      },
      [alertsEnabled],
    );

    const mergeQueueTask = useCallback((updatedTask) => {
      if (!updatedTask) return;
      setQueue((current) => {
        const next = current.filter((item) => item.task_id !== updatedTask.task_id);
        if (updatedTask.status === "open" || updatedTask.status === "claimed") {
          next.unshift(updatedTask);
        }
        return next.sort((a, b) => safeValue(b.created_at).localeCompare(safeValue(a.created_at)));
      });
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

    const loadQueue = useCallback(
      async (options = {}) => {
        const scopeReady = filters.brand && filters.site && filters.language;
        if (!scopeReady) return;
        if (!options.silent) setLoadingQueue(true);
        setError("");
        try {
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(filters)) {
            if (value) query.set(key, value);
          }
          const response = await apiFetch(`/handoffs?${query.toString()}`);
          const tasks = response.tasks || [];
          const nextNew = tasks.filter((item) => item.task_id && !seenIdsRef.current.has(item.task_id));
          tasks.forEach((item) => {
            if (item.task_id) seenIdsRef.current.add(item.task_id);
          });
          setQueue(tasks);
          setLastRefresh(new Date().toLocaleTimeString());
          if (options.detectNew) notifyNewTasks(nextNew);
        } catch (nextError) {
          setError(formatDetail(nextError));
        } finally {
          setLoadingQueue(false);
        }
      },
      [filters, notifyNewTasks],
    );

    const loadTask = useCallback(
      async (id) => {
        const cleanId = (id || "").trim();
        if (!cleanId) return;
        setLoadingTask(true);
        setError("");
        try {
          const response = await apiFetch(`/handoffs/${encodeURIComponent(cleanId)}`);
          setTaskData(response);
          setSelectedId(cleanId);
          updateUrlTaskId(cleanId);
          setNewTaskIds((current) => current.filter((taskId) => taskId !== cleanId));
        } catch (nextError) {
          setError(formatDetail(nextError));
        } finally {
          setLoadingTask(false);
        }
      },
      [updateUrlTaskId],
    );

    const runTaskAction = useCallback(
      async (action, options = {}) => {
        const id = options.taskId || (task && task.task_id);
        if (!id) return null;
        setActionBusy(action);
        setError("");
        try {
          const response = await apiFetch(`/handoffs/${encodeURIComponent(id)}/${action}`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(options.payload || {}),
          });
          setTaskData(response);
          mergeQueueTask(response.task);
          appendRunLine(`${action} completed.`);
          return response;
        } catch (nextError) {
          setError(formatDetail(nextError));
          appendRunLine(`${action} failed: ${formatDetail(nextError)}`);
          return null;
        } finally {
          setActionBusy("");
        }
      },
      [appendRunLine, mergeQueueTask, task],
    );

    const copyPrompt = useCallback(async () => {
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      appendRunLine("Prompt copied to clipboard.");
    }, [appendRunLine, prompt]);

    const enableBrowserAlerts = useCallback(async () => {
      if (!("Notification" in window)) {
        setError("Browser notifications are not available.");
        return;
      }
      const permission = await Notification.requestPermission();
      setAlertsEnabled(permission === "granted");
    }, []);

    const submitPromptToHermes = useCallback(
      async (handoffPrompt) => {
        if (!handoffPrompt) return;
        setError("");
        setSessionId("");
        setRunLines(["Connecting to local Hermes gateway..."]);

        try {
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
          if (!SDK.buildWsUrl) throw new Error("Hermes plugin SDK did not expose buildWsUrl.");

          const ws = new WebSocket(await SDK.buildWsUrl("/api/ws"));
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
            appendRunLine(message.method || message.type || "gateway event");
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
          const createdSessionId = created && (created.session_id || created.id || (created.session && created.session.id));
          if (!createdSessionId) throw new Error("Hermes did not return a session id.");

          appendRunLine("Submitting handoff prompt...");
          await call("prompt.submit", {session_id: createdSessionId, text: handoffPrompt});
          setSessionId(createdSessionId);
          appendRunLine(`Submitted to session ${createdSessionId}.`);
        } catch (nextError) {
          setError(formatDetail(nextError));
          appendRunLine(`Failed: ${formatDetail(nextError)}`);
        }
      },
      [appendRunLine],
    );

    const claimAndStart = useCallback(async () => {
      if (!task) return;
      let nextTaskData = taskData;
      if (task.status === "open") {
        const claimed = await runTaskAction("claim");
        if (!claimed) return;
        nextTaskData = claimed;
      }
      await submitPromptToHermes(nextTaskData && nextTaskData.prompt ? nextTaskData.prompt : prompt);
    }, [prompt, runTaskAction, submitPromptToHermes, task, taskData]);

    useEffect(() => {
      loadConfig();
      const initialTaskId = getQueryTaskId();
      if (initialTaskId) loadTask(initialTaskId);
      return () => {
        if (wsRef.current) wsRef.current.close();
      };
    }, [loadConfig, loadTask]);

    useEffect(() => {
      loadQueue({silent: false, detectNew: false});
    }, [filters.brand, filters.site, filters.language, filters.status, filters.limit]);

    useEffect(() => {
      if (!pollEnabled) return undefined;
      const timer = window.setInterval(() => {
        loadQueue({silent: true, detectNew: true});
      }, pollMs);
      return () => window.clearInterval(timer);
    }, [loadQueue, pollEnabled]);

    useEffect(() => {
      const originalTitle = document.title;
      const count = openCount + claimedCount;
      if (count > 0) document.title = `(${count}) Ruby Support`;
      return () => {
        document.title = originalTitle;
      };
    }, [openCount, claimedCount]);

    const canClaim = task && task.status === "open";
    const canRelease = task && task.status === "claimed";
    const canComplete = task && task.status !== "completed";

    return h(
      "div",
      {className: "rss-root"},
      h(
        "div",
        {className: "rss-header"},
        h("div", null, h("h1", null, "Ruby Support"), h("p", null, "Hermes support workstation")),
        h(
          "div",
          {className: "rss-header-actions"},
          h(ConfigBanner, {config}),
          h(Button, {onClick: () => setPollEnabled((value) => !value)}, pollEnabled ? "Polling on" : "Polling off"),
          h(Button, {onClick: enableBrowserAlerts}, alertsEnabled ? "Alerts on" : "Enable alerts"),
        ),
      ),
      error ? h("div", {className: "rss-error"}, error) : null,
      newTaskIds.length
        ? h("div", {className: "rss-alert"}, `${newTaskIds.length} new handoff${newTaskIds.length > 1 ? "s" : ""} waiting in the queue.`)
        : null,
      h(
        "div",
        {className: "rss-workbench"},
        h(
          "section",
          {className: "rss-panel rss-queue-panel"},
          h(
            "div",
            {className: "rss-section-head"},
            h("div", null, h("h2", null, "Queue"), h("p", null, `${openCount} open · ${claimedCount} claimed · ${lastRefresh || "not refreshed"}`)),
            h(Button, {disabled: loadingQueue, onClick: () => loadQueue({silent: false, detectNew: false})}, loadingQueue ? "Loading" : "Refresh"),
          ),
          h(
            "div",
            {className: "rss-filters"},
            ["brand", "site", "language", "status", "limit"].map((key) =>
              h(
                "label",
                {key, className: "rss-filter"},
                h("span", null, key),
                h("input", {
                  className: "rss-input",
                  value: filters[key],
                  onChange: (event) => setFilters((current) => ({...current, [key]: event.target.value})),
                }),
              ),
            ),
          ),
          queue.length
            ? h(
                "div",
                {className: "rss-list"},
                queue.map((item) =>
                  h(QueueRow, {
                    key: item.task_id,
                    task: item,
                    selected: item.task_id === selectedId,
                    isNew: newTaskIds.includes(item.task_id),
                    onSelect: loadTask,
                  }),
                ),
              )
            : h("div", {className: "rss-empty"}, "No active handoffs."),
        ),
        h(
          "section",
          {className: "rss-panel rss-detail-panel"},
          task
            ? h(
                React.Fragment,
                null,
                h(
                  "div",
                  {className: "rss-section-head"},
                  h("div", null, h("h2", null, "Handoff"), h("p", null, loadingTask ? "Loading task..." : task.task_id)),
                  h(
                    "div",
                    {className: "rss-actions"},
                    context.conversation_url ? h(Button, {href: context.conversation_url}, "Open Chatwoot") : null,
                    h(Button, {onClick: copyPrompt}, "Copy prompt"),
                    canClaim ? h(Button, {disabled: actionBusy === "claim", onClick: () => runTaskAction("claim")}, actionBusy === "claim" ? "Claiming" : "Claim") : null,
                    canRelease ? h(Button, {disabled: actionBusy === "release", onClick: () => runTaskAction("release")}, actionBusy === "release" ? "Releasing" : "Release") : null,
                    canComplete
                      ? h(Button, {disabled: actionBusy === "complete", onClick: () => runTaskAction("complete")}, actionBusy === "complete" ? "Completing" : "Complete")
                      : null,
                    h(Button, {kind: "primary", onClick: claimAndStart}, task.status === "open" ? "Claim & start" : "Start Hermes"),
                  ),
                ),
                h("div", {className: "rss-meta"}, taskMeta(task).map(([label, value]) => h(Chip, {key: label}, `${label}: ${value}`))),
                task.risk_flags && task.risk_flags.length
                  ? h("div", {className: "rss-risk"}, task.risk_flags.map((flag) => h(Chip, {key: flag, tone: "risk"}, flag)))
                  : null,
                h(
                  "div",
                  {className: "rss-grid"},
                  h(Field, {label: "Customer message", value: task.user_message || "", multiline: true}),
                  h(Field, {label: "Suggested reply", value: task.suggested_reply || "", multiline: true}),
                ),
                h(Field, {label: "Prompt preview", value: prompt, multiline: true}),
                sessionId ? h("div", {className: "rss-session"}, "Session: ", h("code", null, sessionId)) : null,
                runLines.length ? h("div", {className: "rss-log"}, runLines.map((line, index) => h("div", {key: `${line}-${index}`}, line))) : null,
              )
            : h(
                "div",
                {className: "rss-empty rss-empty-large"},
                h("h2", null, "Select a handoff"),
                h("p", null, "The workstation polls for active support handoffs. Select one to review context, claim it, and start a local Hermes session."),
              ),
        ),
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
