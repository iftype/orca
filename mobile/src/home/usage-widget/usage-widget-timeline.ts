import type { UsagePercentageDisplay } from '../../../../src/shared/agent-usage/display/usage-percentage-display'
import { getProviderDisplayName } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { formatUsageBarValue, usageBarFill } from '../../accounts/usage/UsageBar'
import { formatResetCountdown } from '../../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import type { Translate } from '../../i18n/mobile-i18n'
import { paletteForScheme, type MobileColorScheme } from '../../theme/mobile-theme'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import type { UsageWidgetSummary } from './usage-widget-summary'

/** A value per color scheme; the widget picks one at render time. */
export type UsageWidgetSchemed = Record<MobileColorScheme, string>

export type UsageWidgetMeter = {
  value: string
  /** The bar's fill, 0 to 1, of the shown percentage (used or remaining). */
  fill: number
  color: UsageWidgetSchemed
  reset?: string
}

export type UsageWidgetAgent = {
  id: string
  title: string
  icon?: UsageWidgetSchemed
  /** The higher of the two windows' used percent, for the automatic "most used" pick. */
  peak: number
  session?: UsageWidgetMeter
  weekly?: UsageWidgetMeter
}

export type UsageWidgetHost = {
  id: string
  name: string
  updated: string
  stale: boolean
  agents: UsageWidgetAgent[]
}

export type UsageWidgetPalette = {
  background: string
  primary: string
  secondary: string
  track: string
}

/** Everything the widget draws, precomputed for one timeline entry: the widget runtime can't import app code.
 * Absent values are left out, never null: expo-widgets stores props in UserDefaults, which rejects NSNull. */
// Bump when the props shape changes; the widget shows its placeholder for any other version.
export const USAGE_WIDGET_PROPS_VERSION = 1

export type UsageWidgetProps = {
  v: typeof USAGE_WIDGET_PROPS_VERSION
  /** Most recently updated first, which the automatic desktop choice shows. */
  hosts: UsageWidgetHost[]
  url: string
  labels: { session: string; weekly: string; empty: string }
  palettes: Record<MobileColorScheme, UsageWidgetPalette>
}

export type UsageWidgetWindowChoice = 'automatic' | 'session' | 'weekly' | 'both'

/** The widget's edit settings, as `environment.configuration`; option values come from setConfigurationParameterEnum. */
export type UsageWidgetConfiguration = {
  desktop?: string | null
  agents?: string[] | null
  window?: UsageWidgetWindowChoice | null
}

export const USAGE_WIDGET_AUTOMATIC_DESKTOP = 'automatic'
// The app refreshes the widget only while it is open and connected, so old numbers fade instead of passing as live.
export const USAGE_WIDGET_STALE_AFTER_MS = 60 * 60_000

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
// Every 5 minutes for the first hour, then hourly for a day, so "N min ago" and the fade stay current.
const ENTRY_OFFSETS_MS = [
  ...Array.from({ length: 12 }, (_, step) => step * 5 * MINUTE_MS),
  ...Array.from({ length: 24 }, (_, step) => (step + 1) * HOUR_MS)
]

function schemed(pick: (scheme: MobileColorScheme) => string): UsageWidgetSchemed {
  return { light: pick('light'), dark: pick('dark') }
}

function widgetPalette(scheme: MobileColorScheme): UsageWidgetPalette {
  const palette = paletteForScheme(scheme)
  return {
    background: palette.bgPanel,
    primary: palette.textPrimary,
    secondary: palette.textSecondary,
    track: palette.bgRaised
  }
}

type SummaryWindow = UsageWidgetSummary['hosts'][number]['providers'][number]['session']

function widgetMeter(
  window: SummaryWindow,
  now: number,
  display: UsagePercentageDisplay,
  t: Translate
): UsageWidgetMeter | undefined {
  if (!window) {
    return undefined
  }
  // A window past its reset no longer holds the saved number.
  const current = window.resetsAt == null || window.resetsAt > now ? window : null
  const used = current?.usedPercent ?? null
  const { shown } = usageBarFill(used, current === null, display)
  return {
    value: formatUsageBarValue(shown, display, t),
    fill: (shown ?? 0) / 100,
    color: schemed(
      (scheme) => usageBarFill(used, current === null, display, paletteForScheme(scheme)).color
    ),
    ...(current?.resetsAt == null ? {} : { reset: formatResetCountdown(current.resetsAt - now) })
  }
}

function updatedLabel(updatedAt: number, now: number, t: Translate): string {
  return now - updatedAt < MINUTE_MS
    ? t('home.usage.updatedJustNow', 'Updated just now')
    : t('home.usage.updatedAgo', 'Updated {{time}} ago', { time: formatTimeAgo(updatedAt, now) })
}

function widgetProps(input: {
  summary: UsageWidgetSummary
  now: number
  display: UsagePercentageDisplay
  icons: Readonly<Record<string, UsageWidgetSchemed>>
  url: string
  t: Translate
}): UsageWidgetProps {
  const { now, display, t } = input
  const hosts = input.summary.hosts
    .map((host): UsageWidgetHost & { updatedAt: number } => {
      const updatedAt = Math.min(
        now,
        Math.max(...host.providers.map((provider) => provider.updatedAt))
      )
      return {
        id: host.id,
        name: host.name,
        updatedAt,
        updated: updatedLabel(updatedAt, now, t),
        stale: now - updatedAt > USAGE_WIDGET_STALE_AFTER_MS,
        agents: host.providers.map((provider): UsageWidgetAgent => {
          const icon = input.icons[provider.provider]
          const session = widgetMeter(provider.session, now, display, t)
          const weekly = widgetMeter(provider.weekly, now, display, t)
          return {
            id: provider.provider,
            title: getProviderDisplayName(provider.provider),
            peak: Math.max(provider.session?.usedPercent ?? -1, provider.weekly?.usedPercent ?? -1),
            ...(icon ? { icon } : {}),
            ...(session ? { session } : {}),
            ...(weekly ? { weekly } : {})
          }
        })
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(({ updatedAt: _updatedAt, ...host }) => host)
  return {
    v: USAGE_WIDGET_PROPS_VERSION,
    hosts,
    url: input.url,
    labels: {
      session: t('accounts.screen.sessionWindow', '5h'),
      weekly: t('accounts.screen.weeklyWindow', '7d'),
      empty: t('home.usage.pairDesktop', 'Pair a desktop to see agent account usage.')
    },
    palettes: { light: widgetPalette('light'), dark: widgetPalette('dark') }
  }
}

/** One entry per label change over the next day; past that the last entry stays, already faded. */
export function buildUsageWidgetTimeline(input: {
  summary: UsageWidgetSummary
  now: number
  display: UsagePercentageDisplay
  icons: Readonly<Record<string, UsageWidgetSchemed>>
  url: string
  t: Translate
}): { date: Date; props: UsageWidgetProps }[] {
  return ENTRY_OFFSETS_MS.map((offset) => {
    const now = input.now + offset
    return { date: new Date(now), props: widgetProps({ ...input, now }) }
  })
}
