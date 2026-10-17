import type { ClientModule } from 'claude-code'

// The draggable line between tasks and updates. Runs on the drawing thread:
// a drag (or ↑/↓ once clicked) posts the new task-area height to the hooks module.

type Props = { rows: number }
type State = { from?: number; delta: number; hover: boolean }

const Divider: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const state = surface.state ?? { delta: 0, hover: false }

  if (surface.state === undefined) {
    surface.onPointer(e => {
      const s = surface.state ?? { delta: 0, hover: false }
      if (e.type === 'down') surface.setState({ ...s, from: e.y, delta: 0 })
      else if (e.type === 'move' && s.from !== undefined) surface.setState({ ...s, delta: e.y - s.from })
      else if (e.type === 'up' && s.from !== undefined) {
        surface.post({ taskRows: props.rows + (e.y - s.from) })
        surface.setState({ ...s, from: undefined, delta: 0 })
      } else if (e.type === 'enter' || e.type === 'leave') surface.setState({ ...s, hover: e.type === 'enter' })
    })
    surface.onKey(e => {
      if (e.key === 'up') surface.post({ taskRows: props.rows - 1 })
      if (e.key === 'down') surface.post({ taskRows: props.rows + 1 })
    })
    surface.setState(state)
  }

  // A short handle in the middle, like a sheet's grabber; the number shows while dragging.
  const width = Math.max(8, surface.columns || 40)
  const handle = state.from !== undefined ? ` ${props.rows + state.delta} rows ` : '────────'
  const side = Math.max(0, Math.floor((width - handle.length) / 2))
  const active = state.hover || state.from !== undefined
  return (
    <Text color={active ? 'claude' : 'subtle'}>
      {' '.repeat(side)}
      {handle}
    </Text>
  )
}

export default Divider
