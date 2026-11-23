/**
 * Browser half of dsh-reading-desk.
 *
 * One sidebar icon plus one main panel sharing the same id; the panel hosts the
 * reading-desk build served by the host half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-reading-desk',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'dsh-reading-desk'
    const SRC = '/plugin/reading-desk/'

    function Icon() {
      return h('svg', { viewBox: '0 0 64 64', width: 24, height: 24, 'aria-hidden': true },
        h('rect', { x: 4, y: 6, width: 56, height: 52, rx: 10, fill: 'currentColor', opacity: 0.16 }),
        h('rect', { x: 14, y: 16, width: 9, height: 32, rx: 2, fill: 'currentColor' }),
        h('rect', { x: 27, y: 16, width: 9, height: 24, rx: 2, fill: 'currentColor', opacity: 0.72 }),
        h('rect', { x: 40, y: 16, width: 9, height: 28, rx: 2, fill: 'currentColor', opacity: 0.46 }))
    }

    function Panel() {
      return h('div', { style: { height: '100%', width: '100%', overflow: 'hidden' } },
        h('iframe', {
          src: SRC,
          title: '读书台',
          style: { width: '100%', height: '100%', border: '0', display: 'block', background: '#fff3e2' },
        }))
    }

    return {
      name: PANEL_ID,
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        if (slots === undefined) return
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: '读书台' },
          () => h(Icon, {}),
        ))
        slots.inject('main', () => slots.register(
          { name: 'main', key: PANEL_ID },
          () => h(Panel, {}),
        ))
      },
    }
  },
})
