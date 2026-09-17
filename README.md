# opencode-zai-quota

[OpenCode](https://opencode.ai) TUI plugin that shows your **Z.AI coding plan
quota** (zai-coding-plan) directly in the sidebar: a gauge for the short usage
window and one for the plan-level allowance, with live colors as you approach
the limits.

## Features

- Panel in the session sidebar with one gauge per quota limit:
  - **Bar** (26 cells) filled according to consumption percentage.
  - **Dynamic colors**: green < 70%, yellow 70-89%, red >= 90%.
  - **Reset countdown** per limit (from `nextResetTime`).
  - Usage / allowance numbers, plan level, and last-refresh time in the header.
- Compact `zai:N%` chip next to the session prompt input.
- Refreshes every minute, on `session.idle`, and on demand via the
  `/zai-quota` command (also in the command palette, `ctrl+p`).
- Colors read from the active OpenCode theme (`api.theme.current.*`) — no
  hardcoded hex values.

## Install

```sh
npm install -g opencode-zai-quota
```

Or add it to `~/.config/opencode/tui.json` (project `.opencode/tui.json` also works):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-zai-quota"]
}
```

Then restart OpenCode.

## Authentication

The token is read automatically from OpenCode's own credentials
(`~/.local/share/opencode/auth.json`): the `zai-coding-plan` entry first, then
`zai`. If you can chat with a `zai-coding-plan` model in OpenCode, the widget
works with zero configuration.

Environment fallbacks: `ZAI_TOKEN` / `Z_AI_TOKEN`.

## Data source

```
GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: Bearer <token>
```

## Commands

| Slash command | Palette title | Description |
|---|---|---|
| `/zai-quota` (`/zq`) | Z.AI quota: refresh now | Force a refresh and show a toast with the result |

## Note

This is a community plugin, not affiliated with Z.AI or OpenCode.

## License

MIT
