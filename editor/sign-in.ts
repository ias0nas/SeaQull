// Requests that connect fail when a SQL login has no user or password the worker can use. The gate
// asks the worker whether that is why and shows the sign-in prompt: one at a time, shared by every
// request waiting on that connection. After a sign-in one request goes first, so a wrong password
// costs one failed login; the rest follow once it gets through.
import type { SignInState } from '../src/protocol.ts'

export const signInCancelled = () => Object.assign(new Error('Sign-in cancelled'), { code: 'cancelled', signInCancelled: true })
export const isSignInCancelled = (err: unknown) => (err as { signInCancelled?: boolean } | null)?.signInCancelled === true

/** Where cancelled connections are kept (the console keeps them across page reloads). */
export type Declined = { has(id: string): boolean; add(id: string): void; delete(id: string): void }

export class SignInGate {
  private readonly state: (connectionId: string) => Promise<SignInState>
  /** Shows the prompt; true once signed in, false when cancelled. */
  private readonly ask: (connectionId: string, state: SignInState) => Promise<boolean>
  /** A request went through after a sign-in. */
  private readonly signedIn?: (connectionId: string) => void
  private readonly asking = new Map<string, Promise<boolean>>()
  /** Prompts wait for the one before (there is one dialog). */
  private prompts: Promise<unknown> = Promise.resolve()
  /** Signed in, and no request has tried the login yet. */
  private readonly untried = new Set<string>()
  /** The request trying it, by connection: the others wait for it. */
  private readonly first = new Map<string, Promise<void>>()
  /** Connections whose prompt was cancelled: only a user action asks again. */
  private readonly declined: Declined

  constructor(state: SignInGate['state'], ask: SignInGate['ask'], signedIn?: SignInGate['signedIn'], declined: Declined = new Set<string>()) {
    this.state = state
    this.ask = ask
    this.signedIn = signedIn
    this.declined = declined
  }

  /** `byUser`: the person asked for it (expand, Retry, Run, the picker), so it may bring the
   *  prompt back after a cancel; anything else (reloads, completion) fails quietly then. */
  async run<T>(connectionId: string, send: () => Promise<T>, byUser = false): Promise<T> {
    for (let afterSignIn = false; ; afterSignIn = true) {
      for (let first = this.first.get(connectionId); first; first = this.first.get(connectionId)) await first
      const attempt = send()
      if (this.untried.delete(connectionId)) {
        const settled = attempt.then(
          () => undefined,
          () => undefined
        )
        this.first.set(connectionId, settled)
        void settled.then(() => this.first.get(connectionId) === settled && this.first.delete(connectionId))
      }
      try {
        const answer = await attempt
        if (afterSignIn) this.signedIn?.(connectionId)
        return answer
      } catch (err) {
        if (isSignInCancelled(err)) throw err
        let state: SignInState
        try {
          state = await this.state(connectionId)
        } catch {
          throw err
        }
        if (!state.needed) throw err
        if (!byUser && this.declined.has(connectionId) && !this.asking.has(connectionId)) throw signInCancelled()
        if (!(await this.signIn(connectionId))) throw signInCancelled()
      }
    }
  }

  private signIn(connectionId: string): Promise<boolean> {
    let asking = this.asking.get(connectionId)
    if (!asking) {
      asking = this.prompts
        .then(async () => {
          // Asked afresh at its turn: another prompt may have settled it meanwhile.
          const state = await this.state(connectionId)
          return state.needed ? this.ask(connectionId, state) : true
        })
        .catch(() => false)
        .then((signedIn) => {
          if (signedIn) {
            this.declined.delete(connectionId)
            this.untried.add(connectionId)
          } else this.declined.add(connectionId)
          return signedIn
        })
        .finally(() => this.asking.delete(connectionId))
      this.prompts = asking
      this.asking.set(connectionId, asking)
    }
    return asking
  }
}
