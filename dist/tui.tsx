// Z.AI coding plan quota widget for OpenCode TUI.
// Shows remaining quota from https://api.z.ai/api/monitor/usage/quota/limit
// in the session sidebar footer, plus /zai-quota and /zai-quota-token commands.
// Token source: opencode credentials at ~/.local/share/opencode/auth.json
// (prefers "zai-coding-plan", falls back to "zai", then env ZAI_TOKEN/Z_AI_TOKEN).
/** @jsxImportSource @opentui/solid */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { TextAttributes } from "@opentui/core"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

const id = "zai-quota"

const REFRESH_MS = 60 * 1000

type QuotaRow = { label: string; usage: number | null; limit: number | null; percent: number | null; resetAt: number | null }

const tui: TuiPlugin = async (api) => {
  const [rows, setRows] = createSignal<QuotaRow[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [updatedAt, setUpdatedAt] = createSignal<number | null>(null)
  const [level, setLevel] = createSignal<string | null>(null)

  const getToken = (): string | undefined => {
    try {
      const auth = JSON.parse(
        readFileSync(`${homedir()}/.local/share/opencode/auth.json`, "utf8"),
      )
      return (
        auth?.["zai-coding-plan"]?.key ||
        auth?.zai?.key ||
        process.env.ZAI_TOKEN ||
        process.env.Z_AI_TOKEN
      )
    } catch {
      return process.env.ZAI_TOKEN || process.env.Z_AI_TOKEN
    }
  }

  const fmt = (n: number | null): string => {
    if (n == null) return "?"
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  // Verified against the live endpoint response:
  // { code: 200, data: { limits: [{ type, unit, number, usage, currentValue,
  //   remaining, percentage, nextResetTime }], level }, success }
  // `unit` 3 = short window (usage is cumulative, currentValue is in-window);
  // `unit` 6 = plan-level allowance. Falls back to a generic scan if the shape changes.
  const parse = (payload: any): QuotaRow[] => {
    const out: QuotaRow[] = []
    const limits = payload?.data?.limits
    if (Array.isArray(limits)) {
      for (const l of limits) {
        if (l == null || typeof l !== "object") continue
        const usage = typeof l.currentValue === "number" ? l.currentValue : (typeof l.usage === "number" ? l.usage : null)
        const limit = usage != null && typeof l.remaining === "number" ? usage + l.remaining : null
        const percent = typeof l.percentage === "number" ? Math.min(l.percentage, 100) : null
        out.push({
          label: l.unit === 3 ? "window" : l.unit === 6 ? "plan" : String(l.type ?? "quota"),
          usage,
          limit,
          percent,
          resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : null,
        })
      }
      if (out.length > 0) return out
    }
    // Generic fallback for unexpected shapes.
    const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null)
    const visit = (node: unknown, label: string) => {
      if (node == null || typeof node !== "object") return
      if (Array.isArray(node)) {
        node.forEach((item, i) => visit(item, item && typeof item === "object" && "type" in (item as object) ? String((item as any).type) : `${label}[${i}]`))
        return
      }
      const obj = node as Record<string, unknown>
      const usage = num(obj.currentValue) ?? num(obj.usage)
      const percent = num(obj.percentage)
      if (usage != null || percent != null) {
        out.push({ label, usage, limit: null, percent, resetAt: num(obj.nextResetTime) })
      }
      for (const [k, v] of Object.entries(obj)) {
        if (v != null && typeof v === "object") visit(v, k)
      }
    }
    visit(payload?.data ?? payload, "plan")
    return out
  }

  const refresh = async () => {
    const token = getToken()
    if (!token) {
      setError("no token — not found in opencode auth.json")
      return
    }
    try {
      const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json()
      const parsed = parse(payload)
      setRows(parsed)
      setLevel(typeof payload?.data?.level === "string" ? payload.data.level : null)
      setError(parsed.length === 0 ? "empty response" : null)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  await refresh()
  const interval = setInterval(refresh, REFRESH_MS)
  const offIdle = api.event.on("session.idle", () => void refresh())

  // Quota-exhaustion guard: when the provider kills the stream with
  // "Weekly/Monthly Limit Exhausted", the turn hangs in the TUI (looks frozen).
  // Detect the session.error, surface a toast with the reset time, refresh the
  // gauges, and abort the stuck turn so the UI unfreezes immediately.
  const handledQuotaAborts = new Set<string>()
  const offStreamError = api.event.on("session.error", (evt: any) => {
    const props = evt?.properties ?? {}
    const err: any = props.error
    const message = String(err?.data?.message ?? err?.message ?? "")
    if (!/limit\s+exhausted/i.test(message)) return
    const sessionID = String(props.sessionID ?? "")
    if (sessionID && handledQuotaAborts.has(sessionID)) return
    if (sessionID) handledQuotaAborts.add(sessionID)
    const resetMatch = message.match(/reset\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^"']*?)(?:["']|$)/i)
    const resetAt = resetMatch?.[1]?.trim()
    void refresh()
    api.ui.toast({
      variant: "error",
      title: "Z.AI quota exhausted",
      message: resetAt
        ? `Limit reached — resets ${resetAt}. Turn aborted; switch model with /models to keep working.`
        : `Limit reached. Turn aborted; switch model with /models to keep working. (${message.slice(0, 120)})`,
      duration: 20000,
    })
    if (sessionID) {
      api.client.session
        .abort({ sessionID } as any)
        .catch(() => {})
    }
  })

  onCleanup(() => {
    clearInterval(interval)
    offIdle()
    offStreamError()
  })
  api.lifecycle.onDispose(() => clearInterval(interval))

  const BAR_W = 26

  const until = (resetAt: number | null): string => {
    if (resetAt == null) return ""
    const mins = Math.max(0, Math.round((resetAt - Date.now()) / 60000))
    return mins >= 60 ? `resets in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `resets in ${mins}m`
  }

  const colorFor = (percent: number | null) => {
    const t = api.theme.current
    if (percent == null) return t.textMuted
    if (percent >= 90) return t.error
    if (percent >= 70) return t.warning
    return t.success
  }

  const Gauge = (r: QuotaRow) => {
    const t = api.theme.current
    const color = colorFor(r.percent)
    const pct = r.percent != null ? `${Math.round(r.percent)}%` : "--"
    const filled = r.percent == null ? 0 : Math.round((Math.min(r.percent, 100) / 100) * BAR_W)
    // Colors are applied per <text> element (not spans) — matches the pattern
    // proven to work in this opencode build (opencode-context-progress).
    return (
      <box flexDirection="column" marginBottom={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={color}>{r.label.padEnd(6, " ")}</text>
          <text fg={t.textMuted}>{r.resetAt != null ? `${until(r.resetAt)}` : ""}</text>
        </box>
        <box flexDirection="row">
          <text fg={color}>{"█".repeat(filled)}</text>
          <text fg={t.border}>{"█".repeat(BAR_W - filled)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={color}>{pct}</text>
          <text fg={t.textMuted}>{r.limit != null ? `${fmt(r.usage)} / ${fmt(r.limit)}` : `${fmt(r.usage)}`}</text>
        </box>
      </box>
    )
  }

  // api.slots.register takes NO id (type: id?: never) and returns the plugin
  // id string — slot lifetime is managed by the host. Matches the pattern of
  // working plugins (e.g. opencode-context-progress).
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const t = api.theme.current
        const current = rows()
        const plan = current.find((r) => r.label === "plan") ?? current[current.length > 1 ? 1 : 0]
        const windowRow = current.find((r) => r.label === "window") ?? current[0]
        return (
          <box
            flexDirection="column"
            marginTop={1}
            marginBottom={1}
            border
            borderStyle="rounded"
            borderColor={t.border}
            paddingLeft={1}
            paddingRight={1}
          >
            <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
              <box flexDirection="row" gap={1}>
                <text fg={t.primary} attributes={TextAttributes.BOLD}>Z.AI PLAN</text>
                {level() && <text fg={t.textMuted}>{level()}</text>}
              </box>
              <text fg={t.textMuted}>{updatedAt() ? new Date(updatedAt()!).toLocaleTimeString() : "…"}</text>
            </box>
            {(() => {
              if (error()) return <text fg={t.error}>{error()}</text>
              if (current.length === 0) return <text fg={t.textMuted}>loading…</text>
              return (
                <>
                  {windowRow && <Gauge {...windowRow} />}
                  {plan && plan !== windowRow && <Gauge {...plan} />}
                </>
              )
            })()}
          </box>
        )
      },
      session_prompt_right() {
        const t = api.theme.current
        const current = rows()
        if (error()) return <text fg={t.error}> zai:? </text>
        const main = current[0]
        if (!main) return <text fg={t.textMuted}> zai:… </text>
        return <text fg={colorFor(main.percent)}>{` zai:${main.percent != null ? `${Math.round(main.percent)}%` : `${fmt(main.usage)}/${fmt(main.limit)}`} `}</text>
      },
    },
  })

  const disposeCommands = api.command.register(() => [
    {
      title: "Z.AI quota: refresh now",
      value: "zai-quota.refresh",
      description: "Fetch current zai-coding-plan usage from the Z.AI API",
      category: "Z.AI",
      slash: { name: "zai-quota", aliases: ["zq"] },
      onSelect: async () => {
        await refresh()
        const current = rows()
        api.ui.toast({
          variant: error() ? "error" : "success",
          title: "Z.AI quota",
          message: error() ?? current.map((r) => `${r.label}: ${fmt(r.usage)}/${fmt(r.limit)}`).join(" | "),
          duration: 4000,
        })
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    disposeCommands()
  })
}

const plugin = { id, tui }
export default plugin
