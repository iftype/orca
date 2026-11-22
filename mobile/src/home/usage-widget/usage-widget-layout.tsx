import { HStack, Image, ProgressView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui'
import {
  background,
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  opacity,
  progressViewStyle,
  resizable,
  tint,
  widgetURL
} from '@expo/ui/swift-ui/modifiers'
import { createWidget, type WidgetEnvironment } from 'expo-widgets'
import type {
  UsageWidgetAgent,
  UsageWidgetConfiguration,
  UsageWidgetMeter,
  UsageWidgetProps
} from './usage-widget-timeline'

// The 'widget' directive turns this into a string the widget extension evaluates: it may only use
// @expo/ui components and modifiers, so everything else arrives precomputed in props.
function UsageWidgetLayout(
  saved: UsageWidgetProps | undefined,
  environment: WidgetEnvironment<UsageWidgetConfiguration>
) {
  'widget'
  // Before the app's first write, after a props format change or with a damaged save, a plain
  // placeholder instead of an error; a widget without a URL opens the app when tapped.
  const placeholder = () => (
    <VStack
      alignment="leading"
      spacing={6}
      modifiers={[
        containerBackground({ type: 'material', material: 'regular' }, 'widget'),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })
      ]}
    >
      <Image systemName="gauge.with.dots.needle.33percent" size={20} />
      {typeof saved?.labels?.empty === 'string' ? (
        <Text
          modifiers={[
            font({ textStyle: 'subheadline' }),
            foregroundStyle({ type: 'hierarchical', style: 'secondary' })
          ]}
        >
          {saved.labels.empty}
        </Text>
      ) : null}
    </VStack>
  )
  // Matches USAGE_WIDGET_PROPS_VERSION; the layout can't import it.
  if (
    saved?.v !== 1 ||
    !Array.isArray(saved.hosts) ||
    !saved.palettes?.light ||
    !saved.palettes?.dark ||
    !saved.labels
  ) {
    return placeholder()
  }
  try {
    return draw(saved)
  } catch {
    return placeholder()
  }

  function draw(props: UsageWidgetProps) {
    const scheme = environment.colorScheme === 'light' ? 'light' : 'dark'
    const palette = props.palettes[scheme]
    const family = environment.widgetFamily ?? 'systemMedium'
    const small = family === 'systemSmall'
    const large = family === 'systemLarge'
    const configuration: UsageWidgetConfiguration = environment.configuration ?? {}
    const root = [containerBackground(palette.background, 'widget'), widgetURL(props.url)]

    // Automatic, or a desktop since unpaired: the one updated most recently.
    const host = props.hosts.find((entry) => entry.id === configuration.desktop) ?? props.hosts[0]
    if (!host) {
      return (
        <VStack
          alignment="leading"
          spacing={6}
          modifiers={[
            ...root,
            frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })
          ]}
        >
          <Text
            modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(palette.secondary)]}
          >
            {props.labels.empty}
          </Text>
        </VStack>
      )
    }

    const limit = small ? 2 : large ? 6 : 3
    const picked = (configuration.agents ?? []).flatMap((id) =>
      host.agents.filter((agent) => agent.id === id)
    )
    let agents: UsageWidgetAgent[]
    if (picked.length > 0) {
      agents = picked.slice(0, limit)
    } else if (large) {
      agents = host.agents.slice(0, limit)
    } else {
      // Most used first to choose, then the app's order so the layout doesn't reshuffle.
      const top = [...host.agents].sort((left, right) => right.peak - left.peak).slice(0, 2)
      agents = host.agents.filter((agent) => top.includes(agent))
    }

    const choice = configuration.window ?? 'automatic'
    const windows: ('session' | 'weekly' | 'either')[] =
      choice === 'session'
        ? ['session']
        : choice === 'weekly'
          ? ['weekly']
          : choice === 'both' || !small
            ? ['session', 'weekly']
            : ['either']
    const meterOf = (agent: UsageWidgetAgent, kind: 'session' | 'weekly' | 'either') =>
      kind === 'either' ? (agent.session ?? agent.weekly) : agent[kind]
    const labelOf = (kind: 'session' | 'weekly' | 'either') =>
      kind === 'session' ? props.labels.session : kind === 'weekly' ? props.labels.weekly : null

    const caption = (text: string, color: string) => (
      <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(color), lineLimit(1)]}>
        {text}
      </Text>
    )

    const bar = (meter: UsageWidgetMeter | undefined) => (
      <ProgressView
        value={meter?.fill ?? 0}
        modifiers={[progressViewStyle('linear'), tint(meter ? meter.color[scheme] : palette.track)]}
      />
    )

    const agentLabel = (agent: UsageWidgetAgent, size: number, strong: boolean) => (
      <HStack spacing={4}>
        {agent.icon ? (
          <Image
            uiImage={agent.icon[scheme]}
            modifiers={[resizable(), frame({ width: size, height: size })]}
          />
        ) : (
          <ZStack
            modifiers={[
              frame({ width: size, height: size }),
              background(palette.track),
              clipShape('circle')
            ]}
          >
            <Text
              modifiers={[
                font({ size: size * 0.6, weight: 'semibold' }),
                foregroundStyle(palette.secondary)
              ]}
            >
              {agent.title.slice(0, 1).toUpperCase()}
            </Text>
          </ZStack>
        )}
        <Text
          modifiers={[
            font(
              strong ? { textStyle: 'subheadline', weight: 'semibold' } : { textStyle: 'caption' }
            ),
            foregroundStyle(strong ? palette.primary : palette.secondary),
            lineLimit(1)
          ]}
        >
          {agent.title}
        </Text>
      </HStack>
    )

    const value = (meter: UsageWidgetMeter | undefined, textStyle: 'caption' | 'subheadline') => (
      <Text
        modifiers={[
          font({ textStyle, weight: 'semibold' }),
          monospacedDigit(),
          foregroundStyle(palette.primary)
        ]}
      >
        {meter?.value ?? '—'}
      </Text>
    )

    const windowMeter = (
      agent: UsageWidgetAgent,
      kind: 'session' | 'weekly' | 'either',
      showsReset: boolean
    ) => {
      const meter = meterOf(agent, kind)
      return (
        <VStack
          alignment="leading"
          spacing={2}
          modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
        >
          <HStack alignment="firstTextBaseline">
            {caption(labelOf(kind) ?? '', palette.secondary)}
            <Spacer minLength={2} />
            {value(meter, 'caption')}
          </HStack>
          {bar(meter)}
          {showsReset && meter?.reset ? caption(meter.reset, palette.secondary) : null}
        </VStack>
      )
    }

    let body
    if (small) {
      body = agents.map((agent) =>
        windows.length === 1 ? (
          <VStack key={agent.id} alignment="leading" spacing={3}>
            <HStack alignment="firstTextBaseline">
              {agentLabel(agent, 12, false)}
              <Spacer minLength={4} />
              {value(meterOf(agent, windows[0]), 'subheadline')}
            </HStack>
            {bar(meterOf(agent, windows[0]))}
          </VStack>
        ) : (
          <VStack key={agent.id} alignment="leading" spacing={3}>
            {agentLabel(agent, 12, false)}
            <HStack alignment="top" spacing={8}>
              {windows.map((kind) => windowMeter(agent, kind, false))}
            </HStack>
          </VStack>
        )
      )
    } else if (large) {
      // One name column for every row, only as wide as the longest name shown (icon, gap and about
      // 8.5pt per subheadline character), so the meters keep room for their full reset line.
      const nameWidth = Math.min(
        104,
        Math.ceil(18 + 8.5 * Math.max(0, ...agents.map((agent) => agent.title.length)))
      )
      body = agents.map((agent) => (
        <HStack key={agent.id} alignment="top" spacing={8}>
          <HStack modifiers={[frame({ width: nameWidth, alignment: 'leading' })]}>
            {agentLabel(agent, 14, true)}
          </HStack>
          {windows.map((kind) => windowMeter(agent, kind, true))}
        </HStack>
      ))
    } else {
      body = (
        <HStack alignment="top" spacing={14}>
          {agents.map((agent) => (
            <VStack
              key={agent.id}
              alignment="leading"
              spacing={6}
              modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
            >
              {agentLabel(agent, 14, true)}
              {windows.map((kind) => windowMeter(agent, kind, true))}
            </VStack>
          ))}
        </HStack>
      )
    }

    return (
      <VStack
        alignment="leading"
        spacing={small ? 6 : 8}
        modifiers={[
          ...root,
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' }),
          opacity(host.stale ? 0.45 : 1)
        ]}
      >
        <HStack spacing={6}>
          <Text
            modifiers={[
              font({ textStyle: 'caption', weight: 'semibold' }),
              foregroundStyle(palette.secondary),
              lineLimit(1)
            ]}
          >
            {host.name}
          </Text>
          <Spacer minLength={4} />
          {small ? null : caption(host.updated, palette.secondary)}
        </HStack>
        {body}
        <Spacer minLength={0} />
        {small ? caption(host.updated, palette.secondary) : null}
      </VStack>
    )
  }
}

export const usageWidget = createWidget<UsageWidgetProps, UsageWidgetConfiguration>(
  'OrcaUsage',
  UsageWidgetLayout
)
