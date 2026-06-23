# ruby-slack-support

Local Hermes Dashboard workstation for support handoffs.

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
- Stores one or more local support profiles. Each profile only needs
  Environment, Brand, and Operator Token.
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

Then restart Hermes Dashboard. A rescan is enough for new sidebar entries, but
backend routes in `dashboard/plugin_api.py` are imported only when Dashboard
starts:

```bash
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

If the page updates but profile setup still returns `Method Not Allowed`, the
Dashboard is still running the previous Python backend. Fully quit and reopen
Hermes Desktop/Dashboard once.

## Local Configuration

Open the `Ruby Support` tab and add a profile. The setup form only asks for:

- Environment: `Production` or `Staging`.
- Brand: for example `xpl` or `daebak`.
- Operator Token: the token already configured in Cloudflare for that operator
  and brand.

The plugin stores profiles locally at:

```text
~/.hermes/ruby-slack-support/config.json
```

The file is created with owner-only permissions when the operating system
allows it. A support operator can add multiple profiles and switch between
brands from the profile dropdown.

The Operator Token must allow these actions for the operator's brand, site, and
language scope:

```text
support:handoff:read
support:handoff:claim
support:handoff:complete
```

Existing environment-variable configuration is still supported as a read-only
fallback profile:

```bash
export RUBY_SUPPORT_API_BASE_URL="https://internal-worker.example.com"
export RUBY_SUPPORT_OPERATOR_TOKEN="op_..."
export RUBY_SUPPORT_DEFAULT_BRAND="xpl"
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
