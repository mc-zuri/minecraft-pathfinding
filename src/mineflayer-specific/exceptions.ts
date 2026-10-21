/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { ResetReason } from '../types'

export class CancelError extends Error {
  constructor (...args: any[]) {
    // console.log('CancelError', args)
    super('Movement canceled: ' + args.join(' '))
  }
}

export class AbortError extends Error {
  constructor (...args: any[]) {
    // console.log('AbortError', args)
    super('Movement aborted: ' + args.join(' '))
  }
}

export class ResetError extends Error {
  static fromReason (reason: ResetReason, ...args: any[]) {
    if (reason === 'goalReassignment') return new ManualResetError(...args)
    else return new ResetError(reason, ...args)
  }

  constructor (public readonly reason: ResetReason, ...args: any[]) {
    // console.log('ResetError', reason, args)
    const extra = args.length > 0 ? `: ${args.join(' ')}` : '.'
    super(`Movement was reset${extra}`)
  }
}

export class ManualResetError extends ResetError {
  constructor (...args: any[]) {
    // console.log('ResetError', reason, args)
    super('goalReassignment', 'manual reset.')
  }
}

export class TickAdvanceError extends Error {
  constructor (label: string, beforeTick: number, afterTick: number) {
    super(`[tick-guard] Tick advanced during await for ${label}: ${beforeTick} -> ${afterTick}`)
    this.name = 'TickAdvanceError'
  }
}

/**
 * goto's end when a move fails 'too low' with the bot in the water (sinking under the move it was to swim): the walk
 * hands back at once, not searching again from under the water, for the caller to take the bot up for air (a
 * surface, a swim to shore). `code` is 'PATHFINDER_SINKING'; `pos` where the bot was, `moveError` the move's failure.
 */
export class PathfinderSinkingError extends Error {
  public readonly code = 'PATHFINDER_SINKING'
  constructor (public readonly pos: import('vec3').Vec3, public readonly moveError: string) {
    super(`Goto: the bot sank under its move in the water at ${pos.toString()} (${moveError})`)
    this.name = 'PathfinderSinkingError'
  }
}
