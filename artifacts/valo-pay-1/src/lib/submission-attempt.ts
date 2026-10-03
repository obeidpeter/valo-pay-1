import { useEffect, useRef } from 'react';
import { useSubmissionRecovery, type SubmissionIdentity } from './submission-recovery';
import { definitiveRefusal, nothingSaved, outcomeIsUnconfirmed, requestClosed, savedAnswerWithheld, submissionFingerprint } from './submission-outcomes';

type SubmissionPolicy = {
  endsRequest: (error: unknown) => boolean;
  failureSettlement: 'original-scope' | 'active-attempt';
};

/** Generated and pilot writes retain a completed key until they recover its receipt or a cancellation. */
export const standardSubmissionPolicy: SubmissionPolicy = {
  endsRequest: requestClosed,
  failureSettlement: 'original-scope',
};

/** Connected actions can end on an explicitly withheld saved answer and then reload their current view. */
export const connectedSubmissionPolicy: SubmissionPolicy = {
  endsRequest: error => requestClosed(error) || savedAnswerWithheld(error),
  // A detached connected action leaves failure recovery to its original page; success still settles its own marker.
  failureSettlement: 'active-attempt',
};

type Options<Input, Payload> = {
  scope?: unknown;
  prepare: (input: Input) => Payload;
  identity: (input: Input) => SubmissionIdentity | null | undefined;
  policy: SubmissionPolicy;
  fingerprint?: (input: Input) => string;
  writes?: (input: Input) => boolean;
  pendingMessage: string;
  problem?: (message: string) => Error;
};

type Request<Input, Payload> = { input: Input; payload: Payload; key: string };
type Attempt<Input, Payload> = Request<Input, Payload> & {
  fingerprint: string;
  pending: boolean;
  unconfirmed: boolean;
  recovery: ReturnType<typeof useSubmissionRecovery>;
};

/**
 * One in-memory user intention, independent of its transport or receipt schema. Input and prepared payload are
 * frozen once, so a retry cannot pick up new form fields or a refreshed server revision. Only the opaque identity
 * is persisted by the recovery provider. React Query owns rendering and callbacks; this hook owns the key's life.
 */
export function useSubmissionAttempt<Input, Payload>(options: Options<Input, Payload>) {
  const recovery = useSubmissionRecovery();
  const attempt = useRef<Attempt<Input, Payload> | null>(null);
  const previousScope = useRef(options.scope);
  const problem = options.problem ?? (message => new Error(message));

  if (previousScope.current !== options.scope || (attempt.current?.recovery && attempt.current.recovery.scope !== recovery?.scope)) {
    const original = attempt.current;
    previousScope.current = options.scope;
    attempt.current = null;
    // Reopening a mounted form promotes its marker too; notify the provider after this render.
    if (original?.recovery) queueMicrotask(() => original.recovery?.keep(original.key));
  }
  useEffect(() => () => {
    if (attempt.current) attempt.current.recovery?.keep(attempt.current.key);
  }, []);

  return {
    hasUnconfirmedOutcome: Boolean(attempt.current?.unconfirmed),
    async execute<Result>(input: Input, send: (request: Request<Input, Payload>) => Promise<Result>): Promise<Result> {
      const fingerprint = (options.fingerprint ?? submissionFingerprint)(input);
      if (attempt.current?.pending) throw problem(options.pendingMessage);
      if (attempt.current?.unconfirmed && attempt.current.fingerprint !== fingerprint) {
        throw problem('We do not know yet whether Valo Pay 1 saved your previous request. Check the original request before you change anything.');
      }
      const identity = options.identity(input);
      if (identity) recovery?.assertAvailable(attempt.current?.key);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
        const originalInput = structuredClone(input);
        attempt.current = {
          fingerprint,
          key: crypto.randomUUID(),
          input: originalInput,
          payload: options.prepare(originalInput),
          pending: false,
          unconfirmed: false,
          recovery: identity ? recovery : null,
        };
      }
      const current = attempt.current;
      const writes = () => options.writes?.(current.input) ?? true;
      // A storage refusal must happen before sending; the same attempt can be tried after storage is restored.
      if (identity && writes()) recovery?.remember(current.key, identity);
      current.pending = true;
      try {
        const result = await send(current);
        current.recovery?.forget(current.key);
        if (attempt.current === current) attempt.current = null;
        return result;
      } catch (error) {
        const over = options.policy.endsRequest(error);
        // An auth/policy refusal on a retry does not prove the earlier uncertain write failed.
        current.unconfirmed = over ? false : current.unconfirmed || (writes() && outcomeIsUnconfirmed(error));
        const finished = !current.unconfirmed && (over || nothingSaved(error) || definitiveRefusal(error));
        const maySettle = options.policy.failureSettlement === 'original-scope' || attempt.current === current;
        if (finished && maySettle) {
          current.recovery?.forget(current.key);
          if (attempt.current === current) attempt.current = null;
        }
        throw error;
      } finally {
        current.pending = false;
      }
    },
    unconfirmedInput(): Input {
      if (!attempt.current?.unconfirmed) throw problem('There is no request waiting to be checked.');
      return attempt.current.input;
    },
    /** Discards private fields only. A journaled identity remains until server recovery settles it. */
    abandon(): boolean {
      if (attempt.current?.pending) return false;
      if (attempt.current) attempt.current.recovery?.keep(attempt.current.key);
      attempt.current = null;
      return true;
    },
  };
}
