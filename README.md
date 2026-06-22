# ruby-slack-support

Local Hermes Dashboard workstation for Slack support handoffs.

This plugin turns Hermes Dashboard into the operator's support workstation. It
polls the active handoff queue, alerts the operator when new tasks arrive,
fetches task context with the operator's local token, and can start a Hermes
session with the handoff prompt already submitted.

Slack alerts can still open the same plugin through a local Dashboard URL, but
Slack is not required for day-to-day support work.

## What It Does

- Adds a `Ruby Support` workstation tab to Hermes Dashboard.
- Polls the active handoff queue and highlights new tasks.
- Supports claim, release, and complete actions so multiple operators do not
  duplicate work.
- Reads `task_id` from URLs such as
  `http://127.0.0.1:9119/ruby-slack-support?task_id=...`.
- Calls the support Worker from local Hermes with
  `RUBY_SUPPORT_OPERATOR_TOKEN`.
- Builds a safe support prompt with the customer message, handoff reason, risk
  flags, sources, Chatwoot context, and raw task JSON.
- Opens a local Hermes session through the Dashboard WebSocket gateway and
  submits the prompt.

## Install

Install directly from GitHub:

```bash
hermes plugins install ruby-public/Hermes-slack-plugin --enable
```

Or install manually:

```bash
mkdir -p ~/.hermes/plugins
git clone https://github.com/ruby-public/Hermes-slack-plugin.git ~/.hermes/plugins/ruby-slack-support
```

Then restart Hermes Dashboard, or rescan dashboard plugins:

```bash
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

Backend routes in `dashboard/plugin_api.py` are loaded at Dashboard startup, so
restart Dashboard after changing this file.

## Local Configuration

Set these environment variables on each support operator's machine before
starting Hermes:

```bash
export RUBY_SUPPORT_API_BASE_URL="https://internal-worker.example.com"
export RUBY_SUPPORT_OPERATOR_TOKEN="op_..."
export RUBY_SUPPORT_DEFAULT_BRAND="xpl"
export RUBY_SUPPORT_DEFAULT_SITE="main"
export RUBY_SUPPORT_DEFAULT_LANGUAGE="ko"
```

`RUBY_SUPPORT_OPERATOR_TOKEN` must allow these actions for the operator's brand,
site, and language scope:

```text
support:handoff:read
support:handoff:claim
support:handoff:complete
```

## Slack Button URL

Slack is optional. If you keep Slack handoff alerts, configure the external
Chatwoot Worker with a local Dashboard URL template:

```text
HERMES_WORKSTATION_BASE_URL=http://127.0.0.1:9119/ruby-slack-support?task_id={task_id}
```

Each support operator uses the same Slack app and the same Slack alert, but the
button opens that operator's own local Hermes Dashboard. Operators can also skip
Slack entirely and work from the plugin queue.

## Development

This repository is the plugin root. Hermes expects this shape:

```text
.
├── plugin.yaml
├── __init__.py
└── dashboard
    ├── manifest.json
    ├── plugin_api.py
    └── dist
        ├── index.js
        └── style.css
```

Quick local checks:

```bash
python3 -m py_compile dashboard/plugin_api.py
node --check dashboard/dist/index.js
```

Do not commit operator tokens, Worker secrets, `.env` files, or local Python
cache directories.
