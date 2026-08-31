// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

afterEach(() => {
  cleanup()
  document.title = ''
  vi.unstubAllEnvs()
})

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    document.title = 'stale title'
    const mounted = render(<DocumentTitle productTitle="SmartFox Harness" />)
    expect(document.title).toBe('SmartFox Harness')
    mounted.rerender(<DocumentTitle title="First title" productTitle="SmartFox Harness" />)
    expect(document.title).toBe('First title — SmartFox Harness')
    mounted.rerender(<DocumentTitle title="Revised title" productTitle="SmartFox Harness" />)
    expect(document.title).toBe('Revised title — SmartFox Harness')
    mounted.rerender(<DocumentTitle productTitle="SmartFox Harness" />)
    expect(document.title).toBe('SmartFox Harness')
    mounted.unmount()
    expect(document.title).toBe('SmartFox Harness')
  })

  it('uses the generic title when the build provides no title', () => {
    const mounted = render(<DocumentTitle title="First title" productTitle="SmartFox Harness" />)
    expect(document.title).toBe('First title — SmartFox Harness')
    mounted.unmount()
    expect(document.title).toBe('SmartFox Harness')
  })
})
