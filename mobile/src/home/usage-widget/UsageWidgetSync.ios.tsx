import AsyncStorage from '@react-native-async-storage/async-storage'
import { Directory, File } from 'expo-file-system'
import * as Linking from 'expo-linking'
import { widgetsDirectory } from 'expo-widgets'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native'
import type Svg from 'react-native-svg'
import { getProviderDisplayName } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { useUsagePercentageDisplay } from '../../accounts/usage/usage-percentage-display-preference'
import { ClaudeIcon, OpenAIIcon } from '../../components/icons/AgentIcons'
import { MOBILE_AGENT_ICON_ASSETS } from '../../components/icons/mobile-agent-icon-assets'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { paletteForScheme } from '../../theme/mobile-theme'
import { usageWidget } from './usage-widget-layout'
import {
  buildUsageWidgetSummary,
  parseUsageWidgetSummary,
  type UsageWidgetSummary
} from './usage-widget-summary'
import {
  buildUsageWidgetTimeline,
  USAGE_WIDGET_AUTOMATIC_DESKTOP,
  type UsageWidgetSchemed
} from './usage-widget-timeline'
import type { UsageWidgetSyncProps } from './UsageWidgetSync'

const SUMMARY_KEY = 'orca:usageWidgetSummary'
// Not a provider id, so the widget's agent lookup skips it.
const USAGE_WIDGET_NO_AGENT = 'none'
// Restart the widget's day-long timeline at least this often while the app is open.
const REWRITE_AFTER_MS = 30 * 60_000
const ICON_PIXELS = 48
const RASTERIZE_TIMEOUT_MS = 5000

const iconAssets: Partial<Record<string, ImageSourcePropType>> = MOBILE_AGENT_ICON_ASSETS
// The usage provider id where it differs from the agent whose mark it shares.
const PROVIDER_ICON_AGENT: Readonly<Record<string, string>> = { 'opencode-go': 'opencode' }

function iconsDirectory(): Directory | null {
  if (!widgetsDirectory) {
    return null
  }
  try {
    const directory = new Directory(widgetsDirectory, 'agent-icons')
    directory.create({ intermediates: true, idempotent: true })
    return directory
  } catch {
    return null
  }
}

// Copied once per app run, so a new build's marks replace the old files.
const copiedIcons = new Map<string, string>()

async function bundledIcon(directory: Directory, provider: string): Promise<string | null> {
  const copied = copiedIcons.get(provider)
  if (copied) {
    return copied
  }
  const source = iconAssets[PROVIDER_ICON_AGENT[provider] ?? provider]
  if (!source) {
    return null
  }
  const uri = Image.resolveAssetSource(source)?.uri
  if (!uri) {
    return null
  }
  const file = new File(directory, `${provider}.png`)
  if (uri.startsWith('file:')) {
    file.create({ overwrite: true })
    file.writeSync(new File(uri).bytesSync())
  } else {
    // Development builds serve assets from Metro.
    await File.downloadFileAsync(uri, file, { idempotent: true })
  }
  copiedIcons.set(provider, file.uri)
  return file.uri
}

function rasterize(svg: Svg | null, directory: Directory, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!svg) {
      resolve(null)
      return
    }
    // A view the native side can't find logs an error and never calls back.
    const timeout = setTimeout(() => resolve(null), RASTERIZE_TIMEOUT_MS)
    svg.toDataURL(
      (base64) => {
        clearTimeout(timeout)
        try {
          const file = new File(directory, `${name}.png`)
          file.create({ overwrite: true })
          file.writeSync(base64, { encoding: 'base64' })
          resolve(file.uri)
        } catch {
          resolve(null)
        }
      },
      { width: ICON_PIXELS, height: ICON_PIXELS }
    )
  })
}

/** Claude's and Codex's marks are SVG paths, which the widget can't draw, so they go over as PNGs. */
function useVectorIcons(): {
  icons: Record<string, UsageWidgetSchemed> | null
  element: React.JSX.Element | null
} {
  const claude = useRef<Svg>(null)
  const codexLight = useRef<Svg>(null)
  const codexDark = useRef<Svg>(null)
  const [icons, setIcons] = useState<Record<string, UsageWidgetSchemed> | null>(null)
  const started = useRef(false)
  // toDataURL looks the view up in the native registry, which logs a red-screen error when it
  // isn't mounted yet, so start only after layout and a frame.
  const onLayout = useCallback(() => {
    if (started.current) {
      return
    }
    started.current = true
    requestAnimationFrame(() => {
      const directory = iconsDirectory()
      if (!directory) {
        setIcons({})
        return
      }
      void Promise.all([
        rasterize(claude.current, directory, 'claude'),
        rasterize(codexLight.current, directory, 'codex-light'),
        rasterize(codexDark.current, directory, 'codex-dark')
      ]).then(([claudeUri, codexLightUri, codexDarkUri]) => {
        const next: Record<string, UsageWidgetSchemed> = {}
        if (claudeUri) {
          next.claude = { light: claudeUri, dark: claudeUri }
        }
        if (codexLightUri && codexDarkUri) {
          next.codex = { light: codexLightUri, dark: codexDarkUri }
        }
        setIcons(next)
      })
    })
  }, [])
  const size = ICON_PIXELS
  return {
    icons,
    element:
      icons === null ? (
        <View pointerEvents="none" style={styles.offscreen} onLayout={onLayout}>
          <ClaudeIcon ref={claude} size={size} />
          <OpenAIIcon ref={codexLight} size={size} color={paletteForScheme('light').textPrimary} />
          <OpenAIIcon ref={codexDark} size={size} color={paletteForScheme('dark').textPrimary} />
        </View>
      ) : null
  }
}

/** Hands Home's live usage to the iOS widget, which never talks to a desktop itself. */
export function UsageWidgetSync({ hosts, hostsLoaded, accountsByHost }: UsageWidgetSyncProps) {
  const t = useMobileTranslation()
  const display = useUsagePercentageDisplay()
  const vector = useVectorIcons()
  const [restored, setRestored] = useState(false)
  // The last summary built, so a desktop that goes offline keeps the numbers it last sent.
  const latest = useRef<UsageWidgetSummary | null>(null)
  const lastWrite = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    AsyncStorage.getItem(SUMMARY_KEY)
      .then((raw) => {
        latest.current = parseUsageWidgetSummary(raw)
      })
      .catch(() => undefined)
      .finally(() => setRestored(true))
  }, [])

  const vectorIcons = vector.icons
  useEffect(() => {
    // An unloaded desktop list would read as "all unpaired" and wipe the widget.
    // Write without waiting for the Claude and Codex marks: a widget with nothing saved shows only
    // a placeholder, and the marks rewrite it once they are ready.
    if (!hostsLoaded || !restored) {
      return
    }
    let cancelled = false
    const summary = buildUsageWidgetSummary({
      hosts,
      liveSnapshots: accountsByHost,
      previous: latest.current
    })
    latest.current = summary
    const providers = [
      ...new Set(summary.hosts.flatMap((host) => host.providers.map((p) => p.provider)))
    ]
    void (async () => {
      const directory = iconsDirectory()
      const icons: Record<string, UsageWidgetSchemed> = { ...vectorIcons }
      for (const provider of providers) {
        if (icons[provider] || !directory) {
          continue
        }
        const uri = await bundledIcon(directory, provider).catch(() => null)
        if (uri) {
          icons[provider] = { light: uri, dark: uri }
        }
      }
      const now = Date.now()
      const entries = buildUsageWidgetTimeline({
        summary,
        now,
        display,
        icons,
        url: Linking.createURL('/', { queryParams: { tab: 'usage' } }),
        t
      })
      const desktopOptions = [
        {
          name: t('home.usage.widgetAutomaticDesktop', 'Most recently updated'),
          value: USAGE_WIDGET_AUTOMATIC_DESKTOP
        },
        // One desktop leaves nothing to choose.
        ...(summary.hosts.length > 1
          ? summary.hosts.map((host) => ({ name: host.name, value: host.id }))
          : [])
      ]
      const agentOptions = [
        // Fixed-size rows can't be emptied once set; this clears one, and the widget skips it.
        { name: t('home.usage.widgetNoAgent', 'None'), value: USAGE_WIDGET_NO_AGENT },
        ...providers.map((provider) => ({
          name: getProviderDisplayName(provider),
          value: provider
        }))
      ]
      const key = JSON.stringify([
        summary,
        display,
        icons,
        entries[0]?.props.labels,
        desktopOptions
      ])
      const last = lastWrite.current
      if (cancelled || (last && last.key === key && now - last.at < REWRITE_AFTER_MS)) {
        return
      }
      // Native failures surface as "Exception in HostFunction: <unknown>", so name the call.
      const call = (name: string, run: () => void) => {
        try {
          run()
        } catch (error) {
          throw new Error(`${name} failed: ${String(error)}`)
        }
      }
      call('setConfigurationParameterEnum(desktop)', () =>
        usageWidget.setConfigurationParameterEnum('desktop', desktopOptions)
      )
      call('setConfigurationParameterEnum(agents)', () =>
        usageWidget.setConfigurationParameterEnum('agents', agentOptions)
      )
      call('updateTimeline', () => usageWidget.updateTimeline(entries))
      lastWrite.current = { key, at: now }
      await AsyncStorage.setItem(SUMMARY_KEY, JSON.stringify(summary))
    })().catch((error: unknown) => console.warn('Usage widget could not be updated', error))
    return () => {
      cancelled = true
    }
  }, [hosts, hostsLoaded, accountsByHost, restored, vectorIcons, display, t])

  return vector.element
}

const styles = StyleSheet.create({
  offscreen: { position: 'absolute', left: -10_000, top: 0, opacity: 0 }
})
