import { fail } from '../errors.js';
import type { SessionState } from './session.js';

export type StateFamily = 'initial' | 'active' | 'halted' | 'terminal';

const FAMILY: Record<SessionState, StateFamily> = {
  idle: 'initial',
  analyzing: 'active',
  planning: 'active',
  running: 'active',
  validating: 'active',
  waiting_for_human: 'halted',
  blocked: 'halted',
  paused: 'halted',
  resumable: 'halted',
  completed: 'terminal',
  failed: 'terminal',
};

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  idle: ['analyzing', 'failed'],
  analyzing: ['planning', 'waiting_for_human', 'paused', 'resumable', 'failed'],
  planning: ['running', 'validating', 'waiting_for_human', 'blocked', 'paused', 'resumable', 'completed', 'failed'],
  running: ['planning', 'validating', 'waiting_for_human', 'blocked', 'paused', 'resumable', 'completed', 'failed'],
  validating: ['planning', 'running', 'waiting_for_human', 'blocked', 'paused', 'resumable', 'completed', 'failed'],
  waiting_for_human: ['analyzing', 'planning', 'blocked', 'resumable', 'completed', 'failed'],
  blocked: ['analyzing', 'planning', 'waiting_for_human', 'resumable', 'completed', 'failed'],
  paused: [
    'analyzing',
    'planning',
    'running',
    'validating',
    'waiting_for_human',
    'blocked',
    'resumable',
    'completed',
    'failed',
  ],
  resumable: ['analyzing', 'planning', 'waiting_for_human', 'blocked', 'completed', 'failed'],
  completed: [],
  failed: [],
};

export function familyOf(state: SessionState): StateFamily {
  return FAMILY[state];
}

export const isActive = (s: SessionState): boolean => FAMILY[s] === 'active';
export const isHalted = (s: SessionState): boolean => FAMILY[s] === 'halted';
export const isTerminal = (s: SessionState): boolean => FAMILY[s] === 'terminal';

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    fail('INVALID_TRANSITION', `Cannot move session from '${from}' to '${to}'.`);
  }
}

export function allowedTransitions(from: SessionState): readonly SessionState[] {
  return TRANSITIONS[from];
}
