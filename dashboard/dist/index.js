(function () {
  const PLUGIN_NAME = "ruby-slack-support";
  const PROFILE_STORAGE_KEY = "ruby-slack-support.activeProfileId";
  const REPLY_DRAFT_STORAGE_PREFIX = "ruby-slack-support.replyDraft";
  const FALLBACK_ENVIRONMENTS = [
    {id: "production", label: "Production"},
    {id: "staging", label: "Staging"},
  ];
  const QUEUE_VIEWS = [
    {id: "active", label: "Pending"},
    {id: "completed", label: "Completed"},
    {id: "all", label: "All"},
  ];
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

  function storedProfileId() {
    try {
      return window.localStorage.getItem(PROFILE_STORAGE_KEY) || "";
    } catch (_error) {
      return "";
    }
  }

  function rememberProfileId(profileId) {
    try {
      if (profileId) window.localStorage.setItem(PROFILE_STORAGE_KEY, profileId);
      else window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    } catch (_error) {
      // Local storage is optional in embedded Dashboard contexts.
    }
  }

  function replyDraftStorageKey(profileId, taskId) {
    if (!profileId || !taskId) return "";
    return `${REPLY_DRAFT_STORAGE_PREFIX}.${profileId}.${taskId}`;
  }

  function loadReplyDraft(profileId, taskId) {
    const key = replyDraftStorageKey(profileId, taskId);
    if (!key) return "";
    try {
      return window.localStorage.getItem(key) || "";
    } catch (_error) {
      return "";
    }
  }

  function persistReplyDraft(profileId, taskId, value) {
    const key = replyDraftStorageKey(profileId, taskId);
    if (!key) return;
    try {
      if (value && value.trim()) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage issues in embedded contexts.
    }
  }

  function withProfile(path, profileId) {
    if (!profileId) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}profile_id=${encodeURIComponent(profileId)}`;
  }

  function queueViewLabel(view) {
    return (QUEUE_VIEWS.find((item) => item.id === view) || QUEUE_VIEWS[0]).label;
  }

  function queueViewMatchesTask(view, task) {
    if (!task) return false;
    if (view === "completed") return task.status === "completed";
    if (view === "all") return true;
    return task.status === "open" || task.status === "claimed";
  }

  function queueStatusForView(view) {
    if (view === "completed") return "completed";
    if (view === "all") return "all";
    return "active";
  }

  function queueSummaryForView(view, queue, filteredQueue, lastRefresh, queueLimit) {
    const loaded = view === "all" ? queue.length : filteredQueue.length;
    const label = view === "completed" ? "completed" : view === "all" ? "conversations" : "pending";
    return [
      `${loaded} ${label}`,
      `${queueViewLabel(view)} view`,
      queue.length >= queueLimit ? `latest ${queueLimit} loaded` : null,
      lastRefresh || "not refreshed",
    ].filter(Boolean).join(" · ");
  }

  function taskIdOf(task) {
    return safeValue(task && task.task_id).trim();
  }

  function compareRecentTasks(a, b) {
    const left = safeValue(b && (b.updated_at || b.completed_at || b.created_at));
    const right = safeValue(a && (a.updated_at || a.completed_at || a.created_at));
    return left.localeCompare(right);
  }

  function environmentOptions(config) {
    const byId = new Map(FALLBACK_ENVIRONMENTS.map((environment) => [environment.id, environment]));
    const configured = config && Array.isArray(config.environments) ? config.environments : [];
    configured.forEach((environment) => {
      if (!environment || !environment.id) return;
      byId.set(environment.id, {
        id: environment.id,
        label: environment.label || environment.id,
      });
    });
    return Array.from(byId.values());
  }

  function defaultProfileForm(config) {
    const environments = environmentOptions(config);
    return {
      id: "",
      environment: environments[0].id,
      brand: "",
      operator_token: "",
    };
  }

  function needsBackendRestart(config) {
    if (!config) return false;
    return config.plugin === PLUGIN_NAME && !Array.isArray(config.profiles);
  }

  async function apiFetch(path, options = {}) {
    const url = `/api/plugins/${PLUGIN_NAME}${path}`;
    const method = (options.method || "GET").toUpperCase();
    if (method === "GET" && !options.body && SDK.fetchJSON) return SDK.fetchJSON(url);

    const fetcher = SDK.authedFetch || window.fetch.bind(window);
    const response = await fetcher(url, options);
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_error) {
        body = text;
      }
    }
    if (!response.ok) {
      const error = new Error(formatDetail(body));
      error.detail = body && body.detail ? body.detail : body;
      throw error;
    }
    return body;
  }

  async function dashboardFetch(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const fetcher = SDK.authedFetch || window.fetch.bind(window);
    const headers = new Headers(options.headers || {});
    const token = window.__HERMES_SESSION_TOKEN__;
    if (token && !headers.has("X-Hermes-Session-Token")) headers.set("X-Hermes-Session-Token", token);

    const response = await fetcher(path, {
      ...options,
      method,
      headers,
      credentials: options.credentials || "include",
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_error) {
        body = text;
      }
    }
    if (!response.ok) {
      const error = new Error(formatDetail(body));
      error.status = response.status;
      error.detail = body && body.detail ? body.detail : body;
      throw error;
    }
    return body;
  }

  async function listDashboardSessions(limit = 10) {
    const response = await dashboardFetch(`/api/sessions?limit=${limit}&offset=0`);
    if (Array.isArray(response)) return response;
    return Array.isArray(response && response.sessions) ? response.sessions : [];
  }

  function taskContext(task) {
    return task && task.context && typeof task.context === "object" ? task.context : {};
  }

  function customerContext(task) {
    const context = taskContext(task);
    const loggedIn = typeof context.customer_logged_in === "boolean"
      ? context.customer_logged_in
      : Boolean(safeValue(context.customer_account).trim());
    return {
      loggedIn,
      loginLabel: loggedIn ? "Logged in" : "Guest",
      account: safeValue(context.customer_account).trim(),
      ip: safeValue(context.customer_ip).trim(),
      device: safeValue(context.customer_device).trim(),
      userAgent: safeValue(context.customer_user_agent).trim(),
      domain: safeValue(context.domain).trim(),
      pageUrl: safeValue(context.page_url).trim(),
    };
  }

  function customerSummaryLine(task) {
    const customer = customerContext(task);
    return [customer.loginLabel, customer.account, customer.domain].filter(Boolean).join(" · ");
  }

  function compactUrl(value) {
    const text = safeValue(value).trim();
    if (!text) return "";
    try {
      const url = new URL(text);
      return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
    } catch (_error) {
      return text;
    }
  }

  function taskDetails(task) {
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
      ["Updated", task.updated_at],
      ["Completed", task.completed_at],
      ["Completed by", task.completed_by],
    ].filter((item) => item[1] !== undefined && item[1] !== null && item[1] !== "");
  }

  function friendlyStatus(task) {
    const status = task && task.status ? String(task.status) : "open";
    if (status === "claimed") return "Claimed";
    if (status === "completed") return "Completed";
    return "Open";
  }

  function friendlyOperator(value) {
    const text = safeValue(value).trim();
    if (!text) return "";
    return text.replace(/^operator:/, "");
  }

  function taskStatusLine(task) {
    if (!task) return "";
    const parts = [friendlyStatus(task)];
    const operator = friendlyOperator(task.assigned_to);
    if (operator) parts.push(`Owner ${operator}`);
    if (task.updated_at) parts.push(`Updated ${formatDateTime(task.updated_at)}`);
    return parts.join(" · ");
  }

  function reviewNotice(task) {
    const flags = Array.isArray(task && task.risk_flags) ? task.risk_flags : [];
    if (flags.includes("payment")) return "Payment-related issue. Verify backend state before replying.";
    if (flags.includes("account")) return "Account-related issue. Check user state before replying.";
    if (flags.includes("promotion")) return "Promotion-related issue. Confirm eligibility before replying.";
    if (task && task.reason === "customer_requested_handoff") return "Customer requested human support.";
    return "";
  }

  function hasKnowledgeResult(task) {
    const sources = Array.isArray(task && task.sources) ? task.sources : [];
    return sources.length > 0;
  }

  function formatDateTime(value) {
    if (!value) return "";
    const numericValue = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    const date = new Date(numericValue);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
  }

  function buildChatResumeUrl(sessionId) {
    return `/chat?resume=${encodeURIComponent(sessionId)}`;
  }

  function taskDisplayLabel(task) {
    if (!task) return "Selected handoff";
    return task.conversation_id ? `Conversation #${task.conversation_id}` : task.task_id || "Selected handoff";
  }

  function taskShortTitle(task) {
    if (!task) return "";
    return safeValue(task.user_message).trim() || taskDisplayLabel(task);
  }

  function buildHermesUpdatePrompt(handoffPrompt) {
    return [
      "Conversation update received after the current Hermes session was already started.",
      "Treat the latest context below as the source of truth and continue the same support investigation.",
      "",
      handoffPrompt,
    ].join("\n");
  }

  function sessionLinkMapFromList(links) {
    const map = new Map();
    (Array.isArray(links) ? links : []).forEach((link) => {
      if (!link || !link.task_id) return;
      map.set(link.task_id, link);
    });
    return map;
  }

  function taskNeedsHermesSync(task, link) {
    if (!task || !link || !(link.gateway_session_id || link.session_id)) return false;
    return taskActivitySignature(task) !== safeValue(link.last_task_signature).trim();
  }

  function sessionGatewayId(link) {
    return safeValue(link && (link.gateway_session_id || link.session_id)).trim();
  }

  function sessionResumeId(link) {
    return safeValue(link && (link.dashboard_session_id || link.session_id || link.gateway_session_id)).trim();
  }

  function hermesSessionTone(link, pendingSync) {
    if (!link || !(link.gateway_session_id || link.session_id || link.dashboard_session_id)) return "neutral";
    if (pendingSync) return "risk";
    if (link.state === "stale" || link.state === "error") return "risk";
    return "claimed";
  }

  function hermesSessionLabel(link, pendingSync) {
    if (!link || !(link.gateway_session_id || link.session_id || link.dashboard_session_id)) return "Not started";
    if (pendingSync) return "Needs update";
    if (link.state === "stale") return "Session missing";
    if (link.state === "error") return "Needs restart";
    return "Ready";
  }

  function conversationMessages(taskData, task) {
    const messages =
      taskData &&
      taskData.task &&
      taskData.task.conversation &&
      Array.isArray(taskData.task.conversation.messages)
        ? taskData.task.conversation.messages
        : [];
    if (messages.length) return messages;
    if (!task || !task.user_message) return [];
    return [
      {
        message_id: task.message_id || task.task_id,
        message_type: "incoming",
        content: task.user_message,
        created_at: task.updated_at || task.created_at,
      },
    ];
  }

  function hasWorkerConversation(taskData) {
    return Boolean(
      taskData &&
      taskData.task &&
      taskData.task.conversation &&
      Array.isArray(taskData.task.conversation.messages) &&
      taskData.task.conversation.messages.length,
    );
  }

  function taskActivitySignature(task) {
    if (!task) return "";
    const messageId = safeValue(task.message_id).trim();
    if (messageId) return `message:${messageId}`;
    const userMessage = safeValue(task.user_message).trim();
    if (userMessage) return `message:${userMessage}`;
    return `updated:${safeValue(task.updated_at || task.created_at).trim()}`;
  }

  function taskSummaryChanged(summary, currentTask) {
    if (!summary || !currentTask) return false;
    return (
      safeValue(summary.status) !== safeValue(currentTask.status) ||
      safeValue(summary.assigned_to) !== safeValue(currentTask.assigned_to) ||
      safeValue(summary.message_id) !== safeValue(currentTask.message_id) ||
      safeValue(summary.updated_at) !== safeValue(currentTask.updated_at)
    );
  }

  function taskStillActive(task) {
    return Boolean(task && (task.status === "open" || task.status === "claimed"));
  }

  function isSupportReplyMessage(message) {
    if (!message) return false;
    const origin = safeValue(message.aihub_origin).trim().toLowerCase();
    if (origin === "aihub:hermes_workstation") return true;
    return false;
  }

  function messageTone(message) {
    if (message && message.private) return "private";
    const type = String((message && (message.message_type || message.sender_type)) || "").toLowerCase();
    if (type.includes("outgoing") || type.includes("agent") || type.includes("user")) return "outgoing";
    if (type.includes("incoming") || type.includes("contact") || type.includes("customer")) return "incoming";
    return "neutral";
  }

  function messageLabel(message, task) {
    if (!message) return "Message";
    if (message.private) return "Private note";
    const origin = safeValue(message.aihub_origin).trim().toLowerCase();
    const tone = messageTone(message);
    const senderName = safeValue(message.sender_name).trim();
    if (isSupportReplyMessage(message, task)) return "Support reply";
    if (origin === "aihub:auto_reply") return "FAQ auto-reply";
    if (message.sender_name) return message.sender_name;
    if (tone === "incoming") return "Customer";
    if (tone === "outgoing") return "Support";
    return message.message_type || message.sender_type || "Message";
  }

  function Button({children, kind = "secondary", disabled, onClick, href, title, type = "button"}) {
    const props = {
      className: `rss-button rss-button-${kind}`,
      disabled,
      onClick,
      title,
      type,
    };
    if (href) {
      props.href = href;
      props.target = "_blank";
      props.rel = "noreferrer";
      delete props.disabled;
      delete props.type;
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

  function ConfigBanner({profile, hasProfiles}) {
    if (profile) {
      return h(
        "div",
        {className: "rss-banner rss-banner-ok"},
        h("span", null, "Worker connected"),
        h("span", {className: "rss-banner-detail"}, `${profile.brand} · ${profile.environment_label || profile.environment}`),
      );
    }
    if (hasProfiles) {
      return h(
        "div",
        {className: "rss-banner rss-banner-warn"},
        h("span", null, "Select profile"),
        h("span", {className: "rss-banner-detail"}, "Choose a brand"),
      );
    }
    return null;
  }

  function ProfileControls({
    profiles,
    selectedProfile,
    activeProfileId,
    loadingQueue,
    onActivate,
    onAdd,
    onEdit,
    onRemove,
  }) {
    return h(
      "div",
      {className: "rss-profile-controls"},
      h(
        "div",
        {className: "rss-profile-header"},
        h("span", {className: "rss-profile-title"}, "Profiles"),
        h(
          "div",
          {className: "rss-profile-buttons rss-profile-buttons-top"},
          h(Button, {onClick: onAdd}, "Add profile"),
          selectedProfile && !selectedProfile.read_only ? h(Button, {onClick: onEdit}, "Edit") : null,
          selectedProfile && !selectedProfile.read_only ? h(Button, {onClick: onRemove}, "Remove") : null,
        ),
      ),
      h(ConfigBanner, {profile: selectedProfile, hasProfiles: profiles.length > 0}),
      profiles.length
        ? h(
            "label",
            {className: "rss-profile-picker rss-profile-picker-wide"},
            h("span", null, "Profile"),
            h(
              "select",
              {
                className: "rss-input rss-select",
                value: activeProfileId,
                disabled: loadingQueue,
                onChange: (event) => onActivate(event.target.value),
              },
              profiles.map((profile) =>
                h("option", {key: profile.id, value: profile.id}, `${profile.brand} / ${profile.environment_label || profile.environment}`),
              ),
            ),
          )
        : null,
    );
  }

  function ConversationThread({messages, task}) {
    if (!messages.length) {
      return h("div", {className: "rss-empty"}, "No conversation history available yet.");
    }
    return h(
      "div",
      {className: "rss-thread"},
      messages.map((message, index) => {
        const tone = messageTone(message);
        const key = message.message_id || message.event_id || `${tone}-${index}`;
        return h(
          "div",
          {key, className: `rss-message rss-message-${tone}`},
          h(
          "div",
          {className: "rss-message-meta"},
          h("span", null, messageLabel(message, task)),
          h("span", null, formatDateTime(message.created_at || message.received_at)),
        ),
        h("div", {className: "rss-message-body"}, message.content || "(empty)"),
      );
      }),
    );
  }

  function KnowledgePanel({task, show, onToggle}) {
    const sources = Array.isArray(task && task.sources) ? task.sources : [];
    const resultText = safeValue(task && task.suggested_reply).trim();
    if (!sources.length) return null;
    return h(
      "section",
      {className: "rss-tool-panel"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h(
          "div",
          null,
          h("h3", null, "Knowledge match"),
          h("p", null, `${sources.length} source${sources.length === 1 ? "" : "s"} found · not a reply draft`),
        ),
        h(Button, {onClick: onToggle}, show ? "Hide" : "View"),
      ),
      show
        ? h(
            "div",
            {className: "rss-knowledge-body"},
            resultText ? h(Field, {label: "Search result summary", value: resultText, multiline: true}) : h("div", {className: "rss-empty"}, "No FAQ result available."),
            sources.length
              ? h(
                  "div",
                  {className: "rss-source-list"},
                  sources.slice(0, 5).map((source, index) => {
                    const meta = source && source.source && typeof source.source === "object" ? source.source : {};
                    return h(
                      "div",
                      {className: "rss-source", key: source.id || index},
                      h("strong", null, meta.title || source.id || `Source ${index + 1}`),
                      h("span", null, `Score ${typeof source.score === "number" ? source.score.toFixed(3) : safeValue(source.score) || "n/a"}`),
                    );
                  }),
                )
              : null,
          )
        : null,
    );
  }

  function CustomerContextCard({task}) {
    const customer = customerContext(task);
    const items = [
      ["Status", customer.loginLabel],
      ["Account", customer.account || "Unknown"],
      ["IP", customer.ip || "Unknown"],
      ["Device", customer.device || "Unknown"],
      ["Domain", customer.domain || "Unknown"],
      ["Page", customer.pageUrl ? compactUrl(customer.pageUrl) : "Unknown"],
    ];
    return h(
      "section",
      {className: "rss-customer-card"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h("div", null, h("h3", null, "Customer context"), h("p", null, "Identity, device, and current page")),
        customer.pageUrl ? h(Button, {href: customer.pageUrl}, "Open page") : null,
      ),
      h(
        "div",
        {className: "rss-customer-grid"},
        items.map(([label, value]) =>
          h("div", {className: "rss-customer-item", key: label}, h("span", null, label), h("strong", null, value)),
        ),
      ),
      customer.userAgent
        ? h("div", {className: "rss-customer-agent"}, h("span", null, "User agent"), h("strong", null, customer.userAgent))
        : null,
    );
  }

  function DetailsPanel({task, show, onToggle}) {
    return h(
      "section",
      {className: "rss-tool-panel"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h("div", null, h("h3", null, "Details"), h("p", null, "Internal diagnostics")),
        h(Button, {onClick: onToggle}, show ? "Hide" : "View"),
      ),
      show ? h("div", {className: "rss-detail-grid"}, taskDetails(task).map(([label, value]) => h("div", {className: "rss-detail-item", key: label}, h("span", null, label), h("strong", null, value)))) : null,
    );
  }

  function ReplyComposer({value, disabled, busy, onChange, onSendReply, onSendAndComplete}) {
    return h(
      "section",
      {className: "rss-reply-panel"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h("div", null, h("h3", null, "Reply"), h("p", null, "Review carefully before sending to Chatwoot")),
      ),
      h("textarea", {
        className: "rss-input rss-reply-textarea",
        value,
        placeholder: "Write the customer reply here, or paste a draft from Hermes...",
        disabled,
        onChange: (event) => onChange(event.target.value),
      }),
      h(
        "div",
        {className: "rss-reply-actions"},
        h(Button, {kind: "primary", disabled: disabled || busy || !value.trim(), onClick: onSendReply}, busy === "reply" ? "Sending" : "Send reply"),
        h(Button, {disabled: disabled || busy || !value.trim(), onClick: onSendAndComplete}, busy === "reply-complete" ? "Sending" : "Send & complete"),
      ),
    );
  }

  function CompletedPanel({task}) {
    const completedBy = friendlyOperator(task && (task.completed_by || task.assigned_to));
    const summary = completedBy
      ? `Completed by ${completedBy}${task && task.completed_at ? ` · ${formatDateTime(task.completed_at)}` : ""}`
      : task && task.completed_at
        ? `Completed ${formatDateTime(task.completed_at)}`
        : "This conversation is currently closed.";
    return h(
      "section",
      {className: "rss-completed-panel"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h("div", null, h("h3", null, "Completed"), h("p", null, summary)),
      ),
      h("div", {className: "rss-session-title"}, "Resume creates a fresh working handoff so you can investigate again, reopen Hermes, or send another reply."),
    );
  }

  function QueueRow({task, selected, isNew, sessionLink, pendingSync, launchBusy, onSelect}) {
    const tone = task.status === "open" ? "open" : task.status === "claimed" ? "claimed" : task.status === "completed" ? "done" : "neutral";
    const assignee = task.status === "completed"
      ? friendlyOperator(task.completed_by || task.assigned_to) || "completed"
      : friendlyOperator(task.assigned_to) || "unassigned";
    const hermesLabel = launchBusy ? "Starting Hermes" : hermesSessionLabel(sessionLink, pendingSync);
    const conversationLabel = task.conversation_id ? `Conversation #${task.conversation_id}` : task.task_id;
    const timestamp = task.status === "completed" ? task.completed_at || task.updated_at || task.created_at : task.updated_at || task.created_at;
    const customerSummary = customerSummaryLine(task);
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
        h("span", {className: "rss-row-assignee"}, assignee),
      ),
      h("span", {className: "rss-row-main"}, task.user_message || task.task_id),
      customerSummary ? h("span", {className: "rss-row-customer"}, customerSummary) : null,
      h("span", {className: "rss-row-sub"}, `${conversationLabel} · ${formatDateTime(timestamp)}`),
      sessionLink || launchBusy
        ? h(
            "span",
            {className: "rss-row-tags"},
            h(Chip, {tone: launchBusy ? "claimed" : hermesSessionTone(sessionLink, pendingSync)}, hermesLabel),
          )
        : null,
    );
  }

  function ProfileForm({config, form, hasProfiles, saving, testing, testResult, errorMessage, onChange, onCancel, onSave, onTest}) {
    const environments = environmentOptions(config);
    const isEdit = Boolean(form.id);
    const backendRestartRequired = needsBackendRestart(config);
    return h(
      "div",
      {
        className: "rss-modal-backdrop",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !saving && !testing) onCancel();
        },
      },
      h(
        "div",
        {className: "rss-modal", role: "dialog", "aria-modal": "true", "aria-label": isEdit ? "Edit profile" : "Add profile"},
        h(
          "div",
          {className: "rss-section-head"},
          h(
            "div",
            null,
            h("h2", null, isEdit ? "Edit Profile" : "Add Profile"),
            h("p", null, hasProfiles ? "Site main · Language ko" : "Setup required · Environment, Brand, Token"),
          ),
          h(
            "div",
            {className: "rss-actions"},
            h(Button, {onClick: onCancel, disabled: saving || testing}, "Cancel"),
            h(Button, {disabled: saving || testing || backendRestartRequired, onClick: onSave}, saving ? "Saving" : "Save"),
            h(Button, {kind: "primary", disabled: saving || testing || backendRestartRequired, onClick: onTest}, testing ? "Testing" : "Save & test"),
          ),
        ),
        backendRestartRequired
          ? h(
              "div",
              {className: "rss-error"},
              "Restart Hermes Dashboard to load the updated Ruby Support backend, then reopen this tab.",
            )
          : null,
        !hasProfiles && !isEdit
          ? h("div", {className: "rss-banner rss-banner-warn rss-modal-banner"}, h("span", null, "Setup required"), h("span", {className: "rss-banner-detail"}, "Environment, Brand, Token"))
          : null,
        errorMessage ? h("div", {className: "rss-error"}, errorMessage) : null,
        h(
          "div",
          {className: "rss-profile-form"},
          h(
            "label",
            {className: "rss-field"},
            h("span", {className: "rss-field-label"}, "Environment"),
            h(
              "select",
              {
                className: "rss-input rss-select",
                value: form.environment,
                onChange: (event) => onChange({environment: event.target.value}),
              },
              environments.map((environment) => h("option", {key: environment.id, value: environment.id}, environment.label)),
            ),
          ),
          h(
            "label",
            {className: "rss-field"},
            h("span", {className: "rss-field-label"}, "Brand"),
            h("input", {
              className: "rss-input",
              value: form.brand,
              placeholder: "xpl",
              onChange: (event) => onChange({brand: event.target.value}),
            }),
          ),
          h(
            "label",
            {className: "rss-field"},
            h("span", {className: "rss-field-label"}, "Operator Token"),
            h("input", {
              className: "rss-input",
              type: "password",
              value: form.operator_token,
              placeholder: isEdit ? "Leave blank to keep current token" : "op_...",
              onChange: (event) => onChange({operator_token: event.target.value}),
            }),
          ),
        ),
        testResult ? h("div", {className: "rss-session"}, testResult) : null,
      ),
    );
  }

  function ConfirmModal({state, onCancel, onConfirm}) {
    if (!state || !state.open) return null;
    return h(
      "div",
      {
        className: "rss-modal-backdrop",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel();
        },
      },
      h(
        "div",
        {className: "rss-modal rss-confirm-modal", role: "dialog", "aria-modal": "true", "aria-label": state.title || "Confirm action"},
        h(
          "div",
          {className: "rss-section-head"},
          h(
            "div",
            {className: "rss-confirm-copy"},
            h("h2", null, state.title || "Confirm action"),
            h("p", {className: "rss-confirm-message"}, state.message || "Please confirm this action."),
          ),
          h(
            "div",
            {className: "rss-actions"},
            h(Button, {onClick: onCancel}, state.cancelLabel || "Cancel"),
            h(Button, {kind: "primary", onClick: onConfirm}, state.confirmLabel || "Confirm"),
          ),
        ),
      ),
    );
  }

  function HermesLaunchModal({launchState, task, runLines, onClose, onOpenSession}) {
    if (!launchState || !launchState.open) return null;
    const titleMap = {
      start: "Start Hermes",
      update: "Send update",
      restart: "Restart Hermes",
    };
    const title = titleMap[launchState.mode] || "Hermes session";
    const isReady = launchState.phase === "ready";
    const isError = launchState.phase === "error";
    const bannerTone = isReady ? "ok" : isError ? "warn" : "neutral";
    const bannerLabel = isReady ? "Session ready" : isError ? "Needs attention" : "Connecting";
    const bannerDetail = isReady
      ? launchState.sessionId
      : isError
        ? "Check the launch log below"
        : "Creating or updating the local Hermes session";

    return h(
      "div",
      {
        className: "rss-modal-backdrop",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      },
      h(
        "div",
        {className: "rss-modal rss-launch-modal", role: "dialog", "aria-modal": "true", "aria-label": title},
        h(
          "div",
          {className: "rss-section-head"},
          h(
            "div",
            null,
            h("h2", null, title),
            h("p", null, taskDisplayLabel(task)),
          ),
          h(
            "div",
            {className: "rss-actions"},
            isReady && launchState.sessionId
              ? h(Button, {kind: "primary", onClick: onOpenSession}, "Open Hermes")
              : null,
            h(Button, {onClick: onClose}, "Close"),
          ),
        ),
        h(
          "div",
          {className: `rss-banner rss-banner-${bannerTone}`},
          h("span", null, bannerLabel),
          h("span", {className: "rss-banner-detail"}, bannerDetail),
        ),
        h(
          "div",
          {className: "rss-launch-copy"},
          h("strong", null, taskShortTitle(task) || "Selected handoff"),
          h("p", null, "You can close this panel at any time. The local Hermes session will keep running."),
        ),
        launchState.error ? h("div", {className: "rss-error"}, launchState.error) : null,
        h("div", {className: "rss-log rss-log-launch"}, runLines.length ? runLines.map((line, index) => h("div", {key: `${line}-${index}`}, line)) : "Waiting for launch updates..."),
      ),
    );
  }

  function HermesSessionPanel({
    task,
    sessionLink,
    pendingSync,
    launchBusy,
    onPrimaryAction,
    onOpenSession,
    onResume,
  }) {
    const completed = task && task.status === "completed";
    const resumeId = sessionResumeId(sessionLink);
    const sessionReady = Boolean(resumeId && sessionLink && sessionLink.state === "ready");
    const sessionUnavailable = Boolean(resumeId && sessionLink && (sessionLink.state === "stale" || sessionLink.state === "error"));
    const title = launchBusy
      ? "Launching local Hermes session"
      : completed
        ? "Conversation is completed"
      : !sessionLink
        ? "Hermes session not started"
        : pendingSync
          ? "New conversation activity is ready to sync"
          : sessionUnavailable
            ? "Previous Hermes session is unavailable"
            : "Hermes session is ready";
    const description = launchBusy
      ? "A local session is being prepared for this handoff."
      : completed
        ? "Resume this conversation when you want to investigate again or prepare another reply."
      : !sessionLink
        ? "Start a local Hermes session when you want to investigate. Open handoffs are claimed automatically."
        : pendingSync
          ? "Send the refreshed conversation context into the existing Hermes session before continuing."
          : sessionUnavailable
            ? "The saved session can no longer be reopened. Start a fresh session to continue the investigation."
            : "Reopen the current Hermes investigation at any time from this workstation.";
    const primaryLabel = launchBusy
      ? "Working..."
      : completed
        ? "Resume"
      : !sessionLink
        ? "Start Hermes"
        : pendingSync
          ? "Send update"
          : sessionUnavailable
            ? "Restart Hermes"
            : "Open Hermes";
    const metaItems = [];
    if (resumeId) metaItems.push(["Session", resumeId]);
    if (task && task.completed_at) metaItems.push(["Completed", formatDateTime(task.completed_at)]);
    if (sessionLink && sessionLink.updated_at) metaItems.push([pendingSync ? "Last sync" : "Synced", formatDateTime(sessionLink.updated_at)]);
    if (sessionLink && sessionLink.last_opened_at) metaItems.push(["Opened", formatDateTime(sessionLink.last_opened_at)]);

    return h(
      "section",
      {className: "rss-session-panel"},
      h(
        "div",
        {className: "rss-subsection-head"},
        h(
          "div",
          null,
          h("h3", null, "Hermes workspace"),
          h("p", null, description),
        ),
        h(
          "div",
          {className: "rss-actions"},
          h(Button, {kind: "primary", disabled: launchBusy, onClick: completed ? onResume : onPrimaryAction}, primaryLabel),
          !completed && sessionReady && pendingSync
            ? h(Button, {disabled: launchBusy, onClick: onOpenSession}, "Open Hermes")
            : null,
        ),
      ),
      h(
        "div",
        {className: "rss-session-summary"},
        h(
          Chip,
          {tone: completed ? "done" : launchBusy ? "claimed" : hermesSessionTone(sessionLink, pendingSync)},
          completed ? "Completed" : launchBusy ? "Starting" : hermesSessionLabel(sessionLink, pendingSync),
        ),
        task && task.status === "open" && !sessionLink && !launchBusy ? h(Chip, {tone: "open"}, "Will claim automatically") : null,
      ),
      h("div", {className: "rss-session-title"}, title),
      metaItems.length
        ? h(
            "div",
            {className: "rss-session-meta"},
            metaItems.map(([label, value]) =>
              h(
                "div",
                {className: "rss-session-meta-item", key: label},
                h("span", null, label),
                label === "Session" ? h("code", null, value) : h("strong", null, value),
              ),
            ),
          )
        : null,
      sessionLink && sessionLink.last_error
        ? h("div", {className: "rss-error"}, sessionLink.last_error)
        : null,
    );
  }

  function LoadingConversationPanel({task}) {
    return h(
      "div",
      {className: "rss-empty rss-empty-large rss-loading-panel"},
      h("h2", null, taskDisplayLabel(task)),
      h("p", {className: "rss-loading-note"}, "Loading the latest conversation context..."),
    );
  }

  function QueueLoadingState({view}) {
    return h(
      "div",
      {className: "rss-queue-loading", role: "status", "aria-live": "polite"},
      h("div", {className: "rss-spinner", "aria-hidden": "true"}),
      h("div", null, h("strong", null, "Loading conversations"), h("p", null, `Fetching ${queueViewLabel(view)} conversations...`)),
    );
  }

  function App() {
    const [config, setConfig] = useState(null);
    const [profiles, setProfiles] = useState([]);
    const [activeProfileId, setActiveProfileId] = useState("");
    const [profileForm, setProfileForm] = useState(() => defaultProfileForm(null));
    const [setupOpen, setSetupOpen] = useState(false);
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileTesting, setProfileTesting] = useState(false);
    const [profileTestResult, setProfileTestResult] = useState("");
    const [sessionLinks, setSessionLinks] = useState([]);
    const [queue, setQueue] = useState([]);
    const [queueView, setQueueView] = useState("active");
    const [selectedId, setSelectedId] = useState(getQueryTaskId);
    const [taskData, setTaskData] = useState(null);
    const [pollEnabled, setPollEnabled] = useState(true);
    const [alertsEnabled, setAlertsEnabled] = useState(false);
    const [loadingQueue, setLoadingQueue] = useState(false);
    const [loadingTask, setLoadingTask] = useState(false);
    const [actionBusy, setActionBusy] = useState("");
    const [error, setError] = useState("");
    const [showPrompt, setShowPrompt] = useState(false);
    const [showKnowledge, setShowKnowledge] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const [replyText, setReplyText] = useState("");
    const [replyBusy, setReplyBusy] = useState("");
    const [lastRefresh, setLastRefresh] = useState("");
    const [newTaskIds, setNewTaskIds] = useState([]);
    const [activeCounts, setActiveCounts] = useState({open: 0, claimed: 0});
    const [activityNotice, setActivityNotice] = useState("");
    const [launchState, setLaunchState] = useState({open: false, phase: "idle", mode: "start", taskId: "", sessionId: "", error: ""});
    const [confirmState, setConfirmState] = useState(null);
    const [runLines, setRunLines] = useState([]);
    const seenTaskStateRef = useRef(new Map());
    const activityTimerRef = useRef(0);
    const wsRef = useRef(null);
    const linksRequestRef = useRef(0);
    const queueRequestRef = useRef(0);
    const notificationRequestRef = useRef(0);
    const taskRequestRef = useRef(0);
    const activeProfileRef = useRef("");
    const queueViewRef = useRef(queueView);
    const selectedIdRef = useRef(selectedId);
    const confirmResolverRef = useRef(null);

    const selectedProfile = useMemo(
      () => profiles.find((profile) => profile.id === activeProfileId) || null,
      [activeProfileId, profiles],
    );
    const taskRecord = taskData && taskData.task ? taskData.task : null;
    const task = taskRecord && (!selectedId || taskIdOf(taskRecord) === selectedId) ? taskRecord : null;
    const selectedSummary = useMemo(
      () => queue.find((item) => item.task_id === selectedId) || null,
      [queue, selectedId],
    );
    const prompt = task && taskData && taskData.prompt ? taskData.prompt : "";
    const messages = conversationMessages(task ? taskData : null, task);
    const workerConversationLoaded = hasWorkerConversation(task ? taskData : null);
    const context = taskContext(task || selectedSummary);
    const sessionLinkMap = useMemo(() => sessionLinkMapFromList(sessionLinks), [sessionLinks]);
    const selectedSessionLink = useMemo(
      () => (task && task.task_id ? sessionLinkMap.get(task.task_id) || null : null),
      [sessionLinkMap, task],
    );
    const filteredQueue = useMemo(
      () => queue.filter((item) => queueViewMatchesTask(queueView, item)),
      [queue, queueView],
    );
    const sessionHasPendingSync = useMemo(
      () => taskNeedsHermesSync(task, selectedSessionLink),
      [selectedSessionLink, task],
    );
    const sessionLaunchBusy = Boolean(
      launchState.phase === "running" && task && launchState.taskId === task.task_id,
    );
    const openCount = activeCounts.open || 0;
    const claimedCount = activeCounts.claimed || 0;
    const pollMs = 15000;
    const queueLimit = 100;
    const detailLoading = Boolean(selectedId && (loadingTask || (taskRecord && taskIdOf(taskRecord) !== selectedId)));

    const appendRunLine = useCallback((line) => {
      setRunLines((current) => [line, ...current].slice(0, 12));
    }, []);

    const closeLaunchModal = useCallback(() => {
      setLaunchState((current) => ({...current, open: false}));
    }, []);

    const resolveConfirmation = useCallback((confirmed) => {
      const resolver = confirmResolverRef.current;
      confirmResolverRef.current = null;
      setConfirmState(null);
      if (resolver) resolver(Boolean(confirmed));
    }, []);

    const requestConfirmation = useCallback((nextState) => {
      if (confirmResolverRef.current) confirmResolverRef.current(false);
      return new Promise((resolve) => {
        confirmResolverRef.current = resolve;
        setConfirmState({
          open: true,
          title: nextState && nextState.title ? nextState.title : "Confirm action",
          message: nextState && nextState.message ? nextState.message : "Please confirm this action.",
          confirmLabel: nextState && nextState.confirmLabel ? nextState.confirmLabel : "Confirm",
          cancelLabel: nextState && nextState.cancelLabel ? nextState.cancelLabel : "Cancel",
        });
      });
    }, []);

    const updateUrlTaskId = useCallback((id) => {
      const nextUrl = new URL(window.location.href);
      if (id) nextUrl.searchParams.set("task_id", id);
      else nextUrl.searchParams.delete("task_id");
      window.history.replaceState(null, "", nextUrl.toString());
    }, []);

    const resetSelection = useCallback(() => {
      selectedIdRef.current = "";
      setSelectedId("");
      setTaskData(null);
      setShowPrompt(false);
      setShowKnowledge(false);
      setShowDetails(false);
      setReplyText("");
      setActivityNotice("");
      setRunLines([]);
      updateUrlTaskId("");
    }, [updateUrlTaskId]);

    const notifyTaskActivity = useCallback(
      (newItems, updatedItems) => {
        const orderedItems = [...newItems, ...updatedItems];
        if (!orderedItems.length) return;

        const ids = Array.from(new Set(orderedItems.map((item) => item.task_id).filter(Boolean)));
        setNewTaskIds((current) => Array.from(new Set([...current, ...ids])));
        const noticeParts = [];
        if (newItems.length) noticeParts.push(`${newItems.length} new handoff${newItems.length === 1 ? "" : "s"}`);
        if (updatedItems.length) noticeParts.push(`${updatedItems.length} updated conversation${updatedItems.length === 1 ? "" : "s"}`);
        setActivityNotice(noticeParts.join(" · "));

        if (activityTimerRef.current) window.clearTimeout(activityTimerRef.current);
        activityTimerRef.current = window.setTimeout(() => {
          setNewTaskIds((current) => current.filter((id) => !ids.includes(id)));
          setActivityNotice("");
          activityTimerRef.current = 0;
        }, 45000);

        if (alertsEnabled && "Notification" in window && Notification.permission === "granted") {
          const first = newItems[0] || updatedItems[0];
          const title =
            newItems.length && updatedItems.length
              ? `${newItems.length} new handoff${newItems.length === 1 ? "" : "s"} · ${updatedItems.length} updated`
              : newItems.length
                ? `${newItems.length} new support handoff${newItems.length === 1 ? "" : "s"}`
                : `${updatedItems.length} conversation update${updatedItems.length === 1 ? "" : "s"}`;
          new Notification(title, {
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
        const next = current
          .filter((item) => item.task_id !== updatedTask.task_id)
          .filter((item) => !(updatedTask.conversation_id && item.conversation_id === updatedTask.conversation_id));
        next.unshift(updatedTask);
        next.sort(compareRecentTasks);
        return next;
      });
    }, []);

    const applyProfiles = useCallback((nextConfig) => {
      if (needsBackendRestart(nextConfig)) {
        setConfig(nextConfig);
        setProfiles([]);
        setActiveProfileId("");
        rememberProfileId("");
        setSessionLinks([]);
        setQueue([]);
        setActiveCounts({open: 0, claimed: 0});
        resetSelection();
        setError("Restart Hermes Dashboard to load the updated Ruby Support backend, then reopen this tab.");
        return;
      }
      const nextProfiles = nextConfig && nextConfig.profiles ? nextConfig.profiles : [];
      setProfiles(nextProfiles);
      setConfig(nextConfig);
      setProfileForm((current) => (current.id || current.brand || current.operator_token ? current : defaultProfileForm(nextConfig)));

      const remembered = storedProfileId();
      const preferred = remembered || (nextConfig && nextConfig.active_profile_id) || "";
      const nextActive = nextProfiles.find((profile) => profile.id === preferred)
        ? preferred
        : nextProfiles.length
          ? nextProfiles[0].id
          : "";
      activeProfileRef.current = nextActive;
      setActiveProfileId(nextActive);
      rememberProfileId(nextActive);
      setSessionLinks(
        nextActive && nextConfig && nextConfig.active_profile_id === nextActive && Array.isArray(nextConfig.session_links)
          ? nextConfig.session_links
          : [],
      );
      if (!nextProfiles.length) {
        setSessionLinks([]);
        setQueue([]);
        setActiveCounts({open: 0, claimed: 0});
        resetSelection();
      }
    }, [resetSelection]);

    const loadConfig = useCallback(async () => {
      try {
        const nextConfig = await apiFetch("/config");
        applyProfiles(nextConfig);
      } catch (nextError) {
        setError(formatDetail(nextError));
      }
    }, [applyProfiles]);

    const loadSessionLinks = useCallback(
      async (profileId = activeProfileId) => {
        if (!profileId) {
          setSessionLinks([]);
          return;
        }
        const requestId = linksRequestRef.current + 1;
        linksRequestRef.current = requestId;
        try {
          const response = await apiFetch(withProfile("/session-links", profileId));
          if (linksRequestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setSessionLinks(Array.isArray(response.links) ? response.links : []);
        } catch (nextError) {
          if (linksRequestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setError(formatDetail(nextError));
        }
      },
      [activeProfileId],
    );

    const persistSessionLink = useCallback(
      async (taskLike, payload) => {
        const taskId = safeValue(taskLike && taskLike.task_id).trim();
        if (!taskId || !activeProfileId) return null;
        const response = await apiFetch(withProfile(`/session-links/${encodeURIComponent(taskId)}`, activeProfileId), {
          method: "PUT",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(payload || {}),
        });
        setSessionLinks(Array.isArray(response.links) ? response.links : []);
        return response.link || null;
      },
      [activeProfileId],
    );

    const removeSessionLink = useCallback(
      async (taskId) => {
        const cleanTaskId = safeValue(taskId).trim();
        if (!cleanTaskId || !activeProfileId) return;
        try {
          const response = await apiFetch(withProfile(`/session-links/${encodeURIComponent(cleanTaskId)}`, activeProfileId), {
            method: "DELETE",
          });
          setSessionLinks(Array.isArray(response.links) ? response.links : []);
        } catch (nextError) {
          setError(formatDetail(nextError));
        }
      },
      [activeProfileId],
    );

    const loadQueue = useCallback(
      async (options = {}) => {
        if (!activeProfileId) return;
        const updateQueue = options.updateQueue !== false;
        const requestRef = updateQueue ? queueRequestRef : notificationRequestRef;
        const requestId = requestRef.current + 1;
        requestRef.current = requestId;
        const profileId = activeProfileId;
        const view = options.statusView || queueViewRef.current || "active";
        const status = queueStatusForView(view);
        if (updateQueue && !options.silent) setLoadingQueue(true);
        setError("");
        try {
          const response = await apiFetch(withProfile(`/handoffs?status=${encodeURIComponent(status)}&limit=${queueLimit}`, profileId));
          if (requestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          const tasks = response.tasks || [];
          let nextNew = [];
          let nextUpdated = [];
          if (status === "active") {
            const previousStates = seenTaskStateRef.current;
            const nextStates = new Map();
            let nextOpenCount = 0;
            let nextClaimedCount = 0;
            tasks.forEach((item) => {
              if (!item || !item.task_id) return;
              const snapshot = {signature: taskActivitySignature(item)};
              const previous = previousStates.get(item.task_id);
              const shouldNotify = item.status === "open" || item.status === "claimed";
              if (item.status === "open") nextOpenCount += 1;
              if (item.status === "claimed") nextClaimedCount += 1;
              if (!previous && shouldNotify) nextNew.push(item);
              else if (previous && previous.signature !== snapshot.signature && shouldNotify) nextUpdated.push(item);
              nextStates.set(item.task_id, snapshot);
            });
            seenTaskStateRef.current = nextStates;
            setActiveCounts({open: nextOpenCount, claimed: nextClaimedCount});
          }
          if (updateQueue) {
            setQueue(tasks.sort(compareRecentTasks));
            setLastRefresh(new Date().toLocaleTimeString());
          }
          if (options.detectNew && status === "active") notifyTaskActivity(nextNew, nextUpdated);
        } catch (nextError) {
          if (requestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setError(formatDetail(nextError));
        } finally {
          if (requestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          if (updateQueue) setLoadingQueue(false);
        }
      },
      [activeProfileId, notifyTaskActivity, queueLimit],
    );

    const loadTask = useCallback(
      async (id, options = {}) => {
        const cleanId = (id || "").trim();
        if (!cleanId || !activeProfileId) return;
        const requestId = taskRequestRef.current + 1;
        taskRequestRef.current = requestId;
        const profileId = activeProfileId;
        const isNewSelection = selectedIdRef.current !== cleanId;
        if (isNewSelection) {
          selectedIdRef.current = cleanId;
          setSelectedId(cleanId);
          setTaskData(null);
          updateUrlTaskId(cleanId);
        }
        if (!options.preserveView) {
          setShowPrompt(false);
          setShowKnowledge(false);
          setShowDetails(false);
        }
        setLoadingTask(true);
        setError("");
        try {
          const response = await apiFetch(withProfile(`/handoffs/${encodeURIComponent(cleanId)}`, profileId));
          if (taskRequestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setTaskData(response);
          selectedIdRef.current = cleanId;
          setSelectedId(cleanId);
          if (!options.preserveReply) setReplyText(loadReplyDraft(profileId, cleanId));
          setNewTaskIds((current) => current.filter((taskId) => taskId !== cleanId));
        } catch (nextError) {
          if (taskRequestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setError(formatDetail(nextError));
        } finally {
          if (taskRequestRef.current !== requestId || activeProfileRef.current !== profileId) return;
          setLoadingTask(false);
        }
      },
      [activeProfileId, updateUrlTaskId],
    );

    const changeQueueView = useCallback(
      (nextView) => {
        queueViewRef.current = nextView;
        setQueueView(nextView);
        loadQueue({silent: false, detectNew: false, statusView: nextView});
        const nextVisible = queue.filter((item) => queueViewMatchesTask(nextView, item));
        const currentSelectedId = selectedIdRef.current;
        const selectedVisible = currentSelectedId && nextVisible.some((item) => item.task_id === currentSelectedId);
        if (selectedVisible) return;
        if (nextVisible.length) {
          loadTask(nextVisible[0].task_id, {preserveReply: false, preserveView: true});
          return;
        }
        resetSelection();
      },
      [loadQueue, loadTask, queue, resetSelection],
    );

    const runTaskAction = useCallback(
      async (action, options = {}) => {
        const id = options.taskId || (task && task.task_id);
        if (!id || !activeProfileId) return null;
        setActionBusy(action);
        setError("");
        try {
          const response = await apiFetch(withProfile(`/handoffs/${encodeURIComponent(id)}/${action}`, activeProfileId), {
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
      [activeProfileId, appendRunLine, mergeQueueTask, task],
    );

    const sendHandoffReply = useCallback(
      async (mode) => {
        if (!task || !activeProfileId) return;
        const content = replyText.trim();
        if (!content) return;
        const busyKey = mode === "complete" ? "reply-complete" : "reply";
        setReplyBusy(busyKey);
        setError("");
        try {
          const response = await apiFetch(withProfile(`/handoffs/${encodeURIComponent(task.task_id)}/reply`, activeProfileId), {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
              content,
              complete: mode === "complete",
            }),
          });
          setTaskData(response);
          mergeQueueTask(response.task);
          setReplyText("");
          appendRunLine(mode === "complete" ? "Reply sent and handoff completed." : "Reply sent.");
          if (mode === "complete") {
            await removeSessionLink(task.task_id);
            loadQueue({silent: true, detectNew: false});
          }
        } catch (nextError) {
          setError(formatDetail(nextError));
          appendRunLine(`Reply failed: ${formatDetail(nextError)}`);
        } finally {
          setReplyBusy("");
        }
      },
      [activeProfileId, appendRunLine, loadQueue, mergeQueueTask, removeSessionLink, replyText, task],
    );

    const openNewProfile = useCallback(() => {
      setProfileForm(defaultProfileForm(config));
      setProfileTestResult("");
      setError("");
      setSetupOpen(true);
    }, [config]);

    const openEditProfile = useCallback(() => {
      if (!selectedProfile || selectedProfile.read_only) return;
      setProfileForm({
        id: selectedProfile.id,
        environment: selectedProfile.environment,
        brand: selectedProfile.brand,
        operator_token: "",
      });
      setProfileTestResult("");
      setError("");
      setSetupOpen(true);
    }, [selectedProfile]);

    const saveProfile = useCallback(
      async (shouldTest) => {
        setProfileSaving(true);
        setProfileTestResult("");
        setError("");
        try {
          const response = await apiFetch("/profiles", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(profileForm),
          });
          const savedProfile = response.profile;
          setProfiles(response.profiles || []);
          setActiveProfileId(savedProfile.id);
          rememberProfileId(savedProfile.id);

          if (shouldTest) {
            setProfileSaving(false);
            setProfileTesting(true);
            const test = await apiFetch(`/profiles/${encodeURIComponent(savedProfile.id)}/test`, {method: "POST"});
            setProfileTestResult(`Connected · ${test.task_count || 0} active handoff${test.task_count === 1 ? "" : "s"}`);
          }

          setSetupOpen(false);
          setProfileForm(defaultProfileForm(config));
          await loadConfig();
        } catch (nextError) {
          setError(formatDetail(nextError));
        } finally {
          setProfileSaving(false);
          setProfileTesting(false);
        }
      },
      [config, loadConfig, profileForm],
    );

    const activateProfile = useCallback(
      async (profileId) => {
        if (!profileId) return;
        activeProfileRef.current = profileId;
        setActiveProfileId(profileId);
        rememberProfileId(profileId);
        if (activityTimerRef.current) {
          window.clearTimeout(activityTimerRef.current);
          activityTimerRef.current = 0;
        }
        resetSelection();
        setSessionLinks([]);
        setQueue([]);
        setActiveCounts({open: 0, claimed: 0});
        setLaunchState({open: false, phase: "idle", mode: "start", taskId: "", sessionId: "", error: ""});
        linksRequestRef.current += 1;
        seenTaskStateRef.current = new Map();
        queueRequestRef.current += 1;
        notificationRequestRef.current += 1;
        taskRequestRef.current += 1;
        try {
          await apiFetch(`/profiles/${encodeURIComponent(profileId)}/activate`, {method: "POST"});
        } catch (nextError) {
          setError(formatDetail(nextError));
        }
      },
      [resetSelection],
    );

    const deleteSelectedProfile = useCallback(async () => {
      if (!selectedProfile || selectedProfile.read_only) return;
      const confirmed = await requestConfirmation({
        title: "Remove profile",
        message: `Remove ${selectedProfile.brand} / ${selectedProfile.environment_label || selectedProfile.environment}?`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      setError("");
      try {
        await apiFetch(`/profiles/${encodeURIComponent(selectedProfile.id)}`, {method: "DELETE"});
        rememberProfileId("");
        setSessionLinks([]);
        await loadConfig();
      } catch (nextError) {
        setError(formatDetail(nextError));
      }
    }, [loadConfig, requestConfirmation, selectedProfile]);

    const copyPrompt = useCallback(async () => {
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      appendRunLine("Context copied to clipboard.");
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
      async ({handoffPrompt, existingSessionId, mode}) => {
        if (!handoffPrompt) return;
        setError("");
        setRunLines(["Connecting to local Hermes gateway..."]);
        let ws = null;

        try {
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
          if (!SDK.buildWsUrl) throw new Error("Hermes plugin SDK did not expose buildWsUrl.");

          ws = new WebSocket(await SDK.buildWsUrl("/api/ws"));
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

          let gatewaySessionId = safeValue(existingSessionId).trim();
          if (!gatewaySessionId) {
            appendRunLine("Creating Hermes session...");
            const created = await call("session.create", {cols: 96, rows: 30});
            gatewaySessionId = created && (created.session_id || created.id || (created.session && created.session.id));
          } else {
            appendRunLine(`Reusing session ${gatewaySessionId}...`);
          }
          if (!gatewaySessionId) throw new Error("Hermes did not return a session id.");

          appendRunLine(mode === "update" ? "Sending latest context..." : "Submitting handoff prompt...");
          await call("prompt.submit", {session_id: gatewaySessionId, text: handoffPrompt});
          appendRunLine(mode === "update" ? `Updated session ${gatewaySessionId}.` : `Submitted to session ${gatewaySessionId}.`);
          return {gatewaySessionId, reused: Boolean(existingSessionId)};
        } catch (nextError) {
          setError(formatDetail(nextError));
          throw nextError;
        } finally {
          if (wsRef.current === ws) wsRef.current = null;
          if (ws) {
            try {
              ws.close();
            } catch (_error) {
              // Ignore close failures after prompt submission.
            }
          }
        }
      },
      [appendRunLine],
    );

    const resolveDashboardSessionId = useCallback(
      async (baselineSessions, startedAtMs) => {
        const knownIds = new Set((baselineSessions || []).map((session) => session && session.id).filter(Boolean));
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, attempt * 250));
          const sessions = await listDashboardSessions(10);
          const fresh = sessions.find((session) => session && session.id && !knownIds.has(session.id));
          if (fresh && fresh.id) return fresh.id;
          const recent = sessions.find((session) => {
            if (!session || !session.id) return false;
            const startedAt = typeof session.started_at === "number" ? session.started_at * 1000 : Number(session.started_at || 0) * 1000;
            return startedAt >= startedAtMs - 5000;
          });
          if (recent && recent.id) return recent.id;
        }
        return "";
      },
      [],
    );

    const verifyHermesSession = useCallback(async (sessionId) => {
      const cleanSessionId = safeValue(sessionId).trim();
      if (!cleanSessionId) return false;
      try {
        await dashboardFetch(`/api/sessions/${encodeURIComponent(cleanSessionId)}/messages`);
        return true;
      } catch (nextError) {
        if (nextError && (nextError.status === 404 || nextError.status === 410)) return false;
        throw nextError;
      }
    }, []);

    const openHermesSession = useCallback(
      async (taskOverride, linkOverride) => {
        const nextTask = taskOverride || task;
        const nextLink = linkOverride || (nextTask && nextTask.task_id ? sessionLinkMap.get(nextTask.task_id) || null : null);
        const resumeId = sessionResumeId(nextLink);
        if (!nextTask || !nextLink || !resumeId) return false;
        try {
          const exists = await verifyHermesSession(resumeId);
          if (!exists) {
            await persistSessionLink(nextTask, {
              dashboard_session_id: resumeId,
              gateway_session_id: sessionGatewayId(nextLink),
              conversation_id: nextTask.conversation_id,
              task_label: taskShortTitle(nextTask),
              state: "stale",
              last_task_signature: nextLink.last_task_signature,
              last_task_updated_at: nextLink.last_task_updated_at,
              last_opened_at: nextLink.last_opened_at,
              last_error: "The saved Hermes session could not be found from the local dashboard.",
            });
            setError("The saved Hermes session could not be reopened. Start Hermes again.");
            return false;
          }
          try {
            await persistSessionLink(nextTask, {
              dashboard_session_id: resumeId,
              gateway_session_id: sessionGatewayId(nextLink),
              conversation_id: nextTask.conversation_id,
              task_label: taskShortTitle(nextTask),
              state: "ready",
              last_task_signature: nextLink.last_task_signature,
              last_task_updated_at: nextLink.last_task_updated_at,
              last_opened_at: String(Date.now()),
              last_error: "",
            });
          } catch (_error) {
            // Session navigation should still work even if local metadata refresh fails.
          }
          window.location.assign(buildChatResumeUrl(resumeId));
          return true;
        } catch (nextError) {
          setError(formatDetail(nextError));
          return false;
        }
      },
      [persistSessionLink, sessionLinkMap, task, verifyHermesSession],
    );

    const triggerHermesLaunch = useCallback(
      async (options = {}) => {
        const currentTask = options.task || task;
        if (!currentTask) return false;
        const existingLink = options.link || (currentTask.task_id ? sessionLinkMap.get(currentTask.task_id) || null : null);
        const currentMode = options.mode || (!existingLink ? "start" : taskNeedsHermesSync(currentTask, existingLink) ? "update" : "start");
        let nextMode = currentMode;
        let nextTaskData = taskData;
        let nextTask = currentTask;
        setLaunchState({
          open: true,
          phase: "running",
          mode: nextMode,
          taskId: currentTask.task_id,
          sessionId: sessionResumeId(existingLink) || sessionGatewayId(existingLink),
          error: "",
        });

        try {
          if (currentTask.status === "open") {
            const claimed = await runTaskAction("claim", {taskId: currentTask.task_id});
            if (!claimed || !claimed.task) {
              const message = "Could not claim the handoff before starting Hermes.";
              setLaunchState({
                open: true,
                phase: "error",
                mode: nextMode,
                taskId: currentTask.task_id,
                sessionId: "",
                error: message,
              });
              return false;
            }
            nextTaskData = claimed;
            nextTask = claimed.task;
          }

          let gatewaySessionId = options.restart ? "" : sessionGatewayId(existingLink);
          const beforeSessions = gatewaySessionId ? [] : await listDashboardSessions(10);
          const startedAtMs = Date.now();
          if (gatewaySessionId) {
            const exists = await verifyHermesSession(sessionResumeId(existingLink) || gatewaySessionId);
            if (!exists) {
              await persistSessionLink(nextTask, {
                dashboard_session_id: sessionResumeId(existingLink),
                gateway_session_id: gatewaySessionId,
                conversation_id: nextTask.conversation_id,
                task_label: taskShortTitle(nextTask),
                state: "stale",
                last_task_signature: safeValue(existingLink && existingLink.last_task_signature).trim(),
                last_task_updated_at: safeValue(existingLink && existingLink.last_task_updated_at).trim(),
                last_opened_at: safeValue(existingLink && existingLink.last_opened_at).trim(),
                last_error: "The saved Hermes session is no longer available.",
              });
              gatewaySessionId = "";
              nextMode = "restart";
            }
          }

          const handoffPrompt = nextTaskData && nextTaskData.prompt ? nextTaskData.prompt : prompt;
          if (!handoffPrompt) throw new Error("Prompt context is not available for this handoff.");

          const submitted = await submitPromptToHermes({
            handoffPrompt: gatewaySessionId ? buildHermesUpdatePrompt(handoffPrompt) : handoffPrompt,
            existingSessionId: gatewaySessionId,
            mode: gatewaySessionId ? "update" : "start",
          });
          if (!submitted || !submitted.gatewaySessionId) throw new Error("Hermes did not confirm the session launch.");

          const dashboardSessionId = gatewaySessionId
            ? sessionResumeId(existingLink)
            : await resolveDashboardSessionId(beforeSessions, startedAtMs);
          const resumableSessionId = dashboardSessionId || submitted.gatewaySessionId;

          await persistSessionLink(nextTask, {
            dashboard_session_id: dashboardSessionId,
            gateway_session_id: submitted.gatewaySessionId,
            conversation_id: nextTask.conversation_id,
            task_label: taskShortTitle(nextTask),
            state: "ready",
            last_task_signature: taskActivitySignature(nextTask),
            last_task_updated_at: safeValue(nextTask.updated_at || nextTask.created_at).trim(),
            last_opened_at: safeValue(existingLink && existingLink.last_opened_at).trim(),
            last_error: "",
          });

          setLaunchState({
            open: true,
            phase: "ready",
            mode: gatewaySessionId ? "update" : nextMode,
            taskId: nextTask.task_id,
            sessionId: resumableSessionId,
            error: "",
          });
          return true;
        } catch (nextError) {
          const message = formatDetail(nextError);
          setError(message);
          appendRunLine(`Failed: ${message}`);
          setLaunchState((current) => ({
            ...current,
            open: true,
            phase: "error",
            error: message,
          }));
          return false;
        }
      },
      [appendRunLine, persistSessionLink, prompt, resolveDashboardSessionId, runTaskAction, sessionLinkMap, submitPromptToHermes, task, taskData, verifyHermesSession],
    );

    const handleHermesPrimaryAction = useCallback(async () => {
      if (!task) return;
      if (!selectedSessionLink) {
        await triggerHermesLaunch({mode: "start"});
        return;
      }
      if (selectedSessionLink.state === "stale" || selectedSessionLink.state === "error") {
        await triggerHermesLaunch({mode: "restart", restart: true, link: selectedSessionLink});
        return;
      }
      if (sessionHasPendingSync) {
        await triggerHermesLaunch({mode: "update", link: selectedSessionLink});
        return;
      }
      await openHermesSession(task, selectedSessionLink);
    }, [openHermesSession, selectedSessionLink, sessionHasPendingSync, task, triggerHermesLaunch]);

    const completeSelectedTask = useCallback(async () => {
      if (!task) return;
      const label = task.conversation_id ? `Conversation #${task.conversation_id}` : task.task_id;
      const confirmed = await requestConfirmation({
        title: "Complete conversation",
        message: `Complete ${label} and remove it from the active queue?`,
        confirmLabel: "Complete",
      });
      if (!confirmed) return;
      const completed = await runTaskAction("complete");
      if (completed && completed.task && completed.task.status === "completed") {
        await removeSessionLink(task.task_id);
        await loadQueue({silent: true, detectNew: false});
      }
    }, [loadQueue, removeSessionLink, requestConfirmation, runTaskAction, task]);

    const resumeSelectedTask = useCallback(async () => {
      if (!task || !activeProfileId) return;
      setActionBusy("resume");
      setError("");
      try {
        const response = await apiFetch(withProfile(`/handoffs/${encodeURIComponent(task.task_id)}/resume`, activeProfileId), {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({}),
        });
        if (task.task_id) await removeSessionLink(task.task_id);
        setTaskData(response);
        setSelectedId(response.task.task_id);
        setReplyText(loadReplyDraft(activeProfileId, response.task.task_id));
        setQueueView("active");
        updateUrlTaskId(response.task.task_id);
        mergeQueueTask(response.task);
        appendRunLine("Conversation resumed.");
        await loadQueue({silent: true, detectNew: false});
        return response;
      } catch (nextError) {
        setError(formatDetail(nextError));
        appendRunLine(`resume failed: ${formatDetail(nextError)}`);
        return null;
      } finally {
        setActionBusy("");
      }
    }, [activeProfileId, appendRunLine, loadQueue, mergeQueueTask, removeSessionLink, task, updateUrlTaskId]);

    const sendReplyAndComplete = useCallback(async () => {
      if (!task || !replyText.trim()) return;
      const label = task.conversation_id ? `Conversation #${task.conversation_id}` : task.task_id;
      const confirmed = await requestConfirmation({
        title: "Send and complete",
        message: `Send this reply to ${label} and complete the handoff?`,
        confirmLabel: "Send & complete",
      });
      if (!confirmed) return;
      await sendHandoffReply("complete");
    }, [replyText, requestConfirmation, sendHandoffReply, task]);

    useEffect(() => {
      activeProfileRef.current = activeProfileId;
    }, [activeProfileId]);

    useEffect(() => {
      selectedIdRef.current = selectedId;
    }, [selectedId]);

    useEffect(() => {
      queueViewRef.current = queueView;
    }, [queueView]);

    useEffect(() => {
      loadConfig();
      return () => {
        if (wsRef.current) wsRef.current.close();
        if (activityTimerRef.current) window.clearTimeout(activityTimerRef.current);
        if (confirmResolverRef.current) {
          confirmResolverRef.current(false);
          confirmResolverRef.current = null;
        }
      };
    }, [loadConfig]);

    useEffect(() => {
      if (!activeProfileId || !selectedId) return;
      persistReplyDraft(activeProfileId, selectedId, replyText);
    }, [activeProfileId, replyText, selectedId]);

    useEffect(() => {
      if (!activeProfileId) return;
      loadSessionLinks(activeProfileId);
      loadQueue({silent: false, detectNew: false});
      const initialTaskId = getQueryTaskId();
      if (initialTaskId) loadTask(initialTaskId);
    }, [activeProfileId, loadQueue, loadSessionLinks, loadTask]);

    useEffect(() => {
      if (!pollEnabled || !activeProfileId) return undefined;
      const timer = window.setInterval(() => {
        const currentView = queueViewRef.current;
        if (currentView === "active") {
          loadQueue({silent: true, detectNew: true, statusView: "active"});
          return;
        }
        loadQueue({silent: true, detectNew: true, statusView: "active", updateQueue: false});
      }, pollMs);
      return () => window.clearInterval(timer);
    }, [activeProfileId, loadQueue, pollEnabled]);

    useEffect(() => {
      if (!selectedId || loadingTask) return;
      const summary = queue.find((item) => item.task_id === selectedId);
      const currentTask = taskData && taskData.task ? taskData.task : null;
      if (!summary) {
        if (taskStillActive(currentTask) && queue.length < queueLimit) loadTask(selectedId, {preserveReply: true, preserveView: true});
        return;
      }
      if (currentTask && taskSummaryChanged(summary, currentTask)) {
        loadTask(selectedId, {preserveReply: true, preserveView: true});
      }
    }, [loadTask, loadingTask, queue, queueLimit, selectedId, taskData]);

    useEffect(() => {
      if (!selectedId || loadingTask) return;
      const selectedVisible = filteredQueue.some((item) => item.task_id === selectedId);
      if (selectedVisible) return;
      if (filteredQueue.length) {
        loadTask(filteredQueue[0].task_id, {preserveReply: false, preserveView: true});
        return;
      }
      const currentTask = taskData && taskData.task ? taskData.task : null;
      if (currentTask && !queueViewMatchesTask(queueView, currentTask)) {
        resetSelection();
      }
    }, [filteredQueue, loadTask, loadingTask, queueView, resetSelection, selectedId, taskData]);

    useEffect(() => {
      if (!setupOpen) return undefined;
      const onKeyDown = (event) => {
        if (event.key === "Escape" && !profileSaving && !profileTesting) {
          setSetupOpen(false);
          setProfileTestResult("");
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [profileSaving, profileTesting, setupOpen]);

    useEffect(() => {
      if (!launchState.open) return undefined;
      const onKeyDown = (event) => {
        if (event.key === "Escape") closeLaunchModal();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [closeLaunchModal, launchState.open]);

    useEffect(() => {
      if (!confirmState || !confirmState.open) return undefined;
      const onKeyDown = (event) => {
        if (event.key === "Escape") resolveConfirmation(false);
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [confirmState, resolveConfirmation]);

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
    const canReply = task && task.status !== "completed";
    const queueSummary = selectedProfile
      ? queueSummaryForView(queueView, queue, filteredQueue, lastRefresh, queueLimit)
      : "No profile selected";
    const launchTask = launchState.taskId
      ? (task && task.task_id === launchState.taskId ? task : queue.find((item) => item.task_id === launchState.taskId) || task)
      : task;

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
          h(Button, {onClick: () => setPollEnabled((value) => !value)}, pollEnabled ? "Polling on" : "Polling off"),
          h(Button, {onClick: enableBrowserAlerts}, alertsEnabled ? "Alerts on" : "Enable alerts"),
        ),
      ),
      error && !setupOpen && !launchState.open ? h("div", {className: "rss-error"}, error) : null,
      activityNotice
        ? h("div", {className: "rss-alert"}, activityNotice)
        : null,
      setupOpen
        ? h(ProfileForm, {
            config,
            form: profileForm,
            hasProfiles: profiles.length > 0,
            saving: profileSaving,
            testing: profileTesting,
            testResult: profileTestResult,
            errorMessage: error,
            onChange: (patch) => setProfileForm((current) => ({...current, ...patch})),
            onCancel: () => {
              setSetupOpen(false);
              setProfileTestResult("");
            },
            onSave: () => saveProfile(false),
            onTest: () => saveProfile(true),
          })
        : null,
      confirmState
        ? h(ConfirmModal, {
            state: confirmState,
            onCancel: () => resolveConfirmation(false),
            onConfirm: () => resolveConfirmation(true),
          })
        : null,
      launchState.open
        ? h(HermesLaunchModal, {
            launchState,
            task: launchTask,
            runLines,
            onClose: closeLaunchModal,
            onOpenSession: () => {
              if (launchTask) {
                openHermesSession(launchTask);
                return;
              }
              if (launchState.sessionId) window.location.assign(buildChatResumeUrl(launchState.sessionId));
            },
          })
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
            h(
              "div",
              null,
              h("h2", null, "Conversations"),
              h("p", null, queueSummary),
            ),
            h(Button, {disabled: loadingQueue || !selectedProfile, onClick: () => loadQueue({silent: false, detectNew: false})}, loadingQueue ? "Loading" : "Refresh"),
          ),
          h(ProfileControls, {
            profiles,
            selectedProfile,
            activeProfileId,
            loadingQueue,
            onActivate: activateProfile,
            onAdd: openNewProfile,
            onEdit: openEditProfile,
            onRemove: deleteSelectedProfile,
          }),
          selectedProfile
            ? h(
                "div",
                {className: "rss-filters"},
                QUEUE_VIEWS.map((view) =>
                  h(
                    Button,
                    {
                      key: view.id,
                      kind: queueView === view.id ? "primary" : "secondary",
                      disabled: loadingQueue,
                      onClick: () => changeQueueView(view.id),
                    },
                    view.label,
                  ),
                ),
              )
            : null,
          loadingQueue
            ? h(QueueLoadingState, {view: queueView})
            : filteredQueue.length
            ? h(
                "div",
                {className: "rss-list"},
                filteredQueue.map((item) =>
                  h(QueueRow, {
                    key: item.task_id,
                    task: item,
                    selected: item.task_id === selectedId,
                    isNew: newTaskIds.includes(item.task_id),
                    sessionLink: sessionLinkMap.get(item.task_id) || null,
                    pendingSync: taskNeedsHermesSync(item, sessionLinkMap.get(item.task_id) || null),
                    launchBusy: launchState.phase === "running" && launchState.taskId === item.task_id,
                    onSelect: loadTask,
                  }),
                ),
              )
            : h(
                "div",
                {className: "rss-empty"},
                selectedProfile
                  ? queueView === "completed"
                    ? "No completed conversations."
                    : queueView === "all"
                      ? "No conversations loaded."
                      : "No pending conversations."
                  : "Add a profile to start polling.",
              ),
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
                    h("div", null, h("h2", null, taskDisplayLabel(task)), h("p", null, loadingTask ? "Loading task..." : taskStatusLine(task))),
                    h(
                    "div",
                    {className: "rss-actions"},
                    context.conversation_url ? h(Button, {href: context.conversation_url}, "Open Chatwoot") : null,
                    h(Button, {onClick: copyPrompt}, "Copy context"),
                    canClaim ? h(Button, {disabled: actionBusy === "claim", onClick: () => runTaskAction("claim")}, actionBusy === "claim" ? "Claiming" : "Claim") : null,
                    canRelease ? h(Button, {disabled: actionBusy === "release", onClick: () => runTaskAction("release")}, actionBusy === "release" ? "Releasing" : "Release") : null,
                    canComplete
                      ? h(Button, {disabled: actionBusy === "complete", onClick: completeSelectedTask}, actionBusy === "complete" ? "Completing" : "Complete")
                      : null,
                  ),
                ),
                reviewNotice(task) ? h("div", {className: "rss-review-notice"}, reviewNotice(task)) : null,
                h(HermesSessionPanel, {
                  task,
                  sessionLink: selectedSessionLink,
                  pendingSync: sessionHasPendingSync,
                  launchBusy: sessionLaunchBusy,
                  onPrimaryAction: handleHermesPrimaryAction,
                  onOpenSession: () => openHermesSession(task, selectedSessionLink),
                  onResume: resumeSelectedTask,
                }),
                h(CustomerContextCard, {task}),
                h(
                  "section",
                  {className: "rss-conversation-block"},
                  h(
                    "div",
                    {className: "rss-subsection-head"},
                    h(
                      "div",
                      null,
                      h("h3", null, "Conversation"),
                      h("p", null, workerConversationLoaded
                        ? `${messages.length} message${messages.length === 1 ? "" : "s"} · full context for Hermes`
                        : `${messages.length} message${messages.length === 1 ? "" : "s"} · latest message fallback`),
                    ),
                    context.conversation_url ? h(Button, {href: context.conversation_url}, "Open full Chatwoot") : null,
                  ),
                  h(ConversationThread, {messages, task}),
                ),
                canReply
                  ? h(ReplyComposer, {
                      value: replyText,
                      disabled: !canReply,
                      busy: replyBusy,
                      onChange: setReplyText,
                      onSendReply: () => sendHandoffReply("reply"),
                      onSendAndComplete: sendReplyAndComplete,
                    })
                  : h(CompletedPanel, {task}),
                hasKnowledgeResult(task) ? h(KnowledgePanel, {task, show: showKnowledge, onToggle: () => setShowKnowledge((value) => !value)}) : null,
                h(
                  "section",
                  {className: "rss-tool-panel"},
                  h(
                    "div",
                    {className: "rss-subsection-head"},
                    h("div", null, h("h3", null, "Hermes prompt"), h("p", null, "Includes conversation history and task metadata")),
                    h(Button, {onClick: () => setShowPrompt((value) => !value)}, showPrompt ? "Hide prompt" : "View prompt"),
                  ),
                  showPrompt ? h(Field, {label: "Prompt preview", value: prompt, multiline: true}) : null,
                ),
                h(DetailsPanel, {task, show: showDetails, onToggle: () => setShowDetails((value) => !value)}),
              )
            : selectedId && detailLoading
              ? h(LoadingConversationPanel, {task: selectedSummary || {task_id: selectedId}})
              : selectedId
                ? h(
                    "div",
                    {className: "rss-empty rss-empty-large"},
                    h("h2", null, taskDisplayLabel(selectedSummary || {task_id: selectedId})),
                    h("p", null, error ? "Could not load the latest conversation. Refresh and try again." : "Conversation details are unavailable right now."),
                  )
                : h(
                    "div",
                    {className: "rss-empty rss-empty-large"},
                    h("h2", null, selectedProfile ? "Select a conversation" : "No profile selected"),
                    h(
                      "p",
                      null,
                      selectedProfile
                        ? "Select one to review context, start Hermes, and continue the support workflow."
                        : "Use Add profile to connect a brand.",
                    ),
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
