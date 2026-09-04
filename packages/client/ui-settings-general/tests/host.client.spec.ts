import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-settings-general host', () => {
  it('keeps the host Loader entry inert', () => {
    expect(apply).not.toThrow()
  })
})
