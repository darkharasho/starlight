import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { guardStdio, isLostConsoleError } from '../../src/main/stdio-guard.js'

function err(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code })
}

describe('guardStdio', () => {
  test('an EPIPE on stdout is not an uncaught exception', () => {
    const out = new EventEmitter()
    const rethrow = vi.fn()
    guardStdio([out], rethrow)
    // Without a listener, emit('error') throws — which is the crash users saw.
    expect(() => out.emit('error', err('EPIPE'))).not.toThrow()
    expect(rethrow).not.toHaveBeenCalled()
  })

  test('EIO and a destroyed stream are ignored too', () => {
    const out = new EventEmitter()
    const rethrow = vi.fn()
    guardStdio([out], rethrow)
    out.emit('error', err('EIO'))
    out.emit('error', err('ERR_STREAM_DESTROYED'))
    expect(rethrow).not.toHaveBeenCalled()
  })

  test('other stream errors are still raised', () => {
    const out = new EventEmitter()
    const rethrow = vi.fn()
    guardStdio([out], rethrow)
    const e = err('EACCES')
    out.emit('error', e)
    expect(rethrow).toHaveBeenCalledWith(e)
  })

  test('isLostConsoleError ignores values without a code', () => {
    expect(isLostConsoleError(new Error('x'))).toBe(false)
    expect(isLostConsoleError(null)).toBe(false)
    expect(isLostConsoleError(err('EPIPE'))).toBe(true)
  })
})
