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

/**
 * goto's end short of its goal, not called off (cancel, a new goto, handBack): the search found no way on (`reason`
 * the search's end: 'noPath', 'timeout' no nearer, 'canceled'), or the walk ended where the goal doesn't hold
 * ('pathEnded'). `code` is 'GOAL_NOT_REACHED'; `pos` where the bot stands, `goal` the goto's, `lastMoveError` the
 * error of the last move that failed, if one did. goto resolved then, the bot outside a room of leaves whose breaks
 * the server refused (spawn protection), and its caller went on as if it had got there.
 */
export class GoalNotReachedError extends Error {
  public readonly code = 'GOAL_NOT_REACHED'
  constructor (public readonly pos: import('vec3').Vec3, public readonly goal: unknown, public readonly reason: string, public readonly lastMoveError?: string) {
    super(`Goto: ended at ${pos.toString()}, short of the goal (${reason === 'pathEnded' ? 'the path ended there' : `the search ended: ${reason}`}${lastMoveError != null ? `; the last move failed: ${lastMoveError}` : ''})`)
    this.name = 'GoalNotReachedError'
  }
}
