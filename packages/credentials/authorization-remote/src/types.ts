/**
 * Browser-safe wire vocabulary of the authorization Remote namespace. Every
 * value here crosses the `/api` channel as JSON, so nothing carries an
 * `AbortSignal`, a class instance, or a secret: prompt answers travel only
 * from the browser toward the Host, and stored credential values never travel
 * at all.
 *
 * @module @deepseek-ai/dsh-authorization-remote/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No authorization flow claims this credential record. */
    'authorization/no-flow': { readonly key: string }
    /** The flow offers no method under this id. */
    'authorization/unknown-method': { readonly key: string; readonly method: string }
    /** An attempt for this record is already running. */
    'authorization/in-flight': { readonly key: string }
    /** No attempt runs under this id. */
    'authorization/unknown-attempt': { readonly attempt: string }
    /** No pending prompt answers under this id on this attempt. */
    'authorization/unknown-prompt': { readonly attempt: string; readonly prompt: string }
    /** The prompt was withdrawn by its flow, or already answered. */
    'authorization/inactive-prompt': { readonly attempt: string; readonly prompt: string }
  }
}

/** One sign-in method a flow offers, as a surface renders it. */
export interface AuthorizationMethodView {
  /** Flow-owned identifier, echoed back when the caller picks this method. */
  readonly id: string
  /** User-facing label for a picker. */
  readonly label: string
}

/** One registered flow as a surface sees it. */
export interface AuthorizationFlowView {
  /** The credential record this flow writes, as `scope/id`. */
  readonly key: string
  /** The owning plugin's scope. */
  readonly scope: string
  /** The credential id within its scope. */
  readonly id: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods this flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethodView[]
  /** Whether an attempt for this record is running right now. */
  readonly inFlight: boolean
}

/** Whether a stored grant exists for a record, without revealing anything it holds. */
export interface AuthorizationStatusView {
  /** True once a grant record is stored; answers nothing about its contents. */
  readonly configured: boolean
}

/** The attempt a `begin` call opened. */
export interface AuthorizationAttemptView {
  /** Opaque id the follow-up calls address. */
  readonly attemptId: string
  /** The credential record this attempt authorizes, as `scope/id`. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The method id this attempt runs. */
  readonly method: string
}

/** One option of a select prompt, as a surface renders it. */
export interface AuthorizationPromptOptionView {
  /** Value returned when this option is chosen. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
  /** Optional extra context rendered by capable surfaces. */
  readonly description?: string
}

/** One question a flow waits on, without its Host-side withdrawal signal. */
export type AuthorizationPromptView =
  | {
    /** Opaque id the answer calls address. */
    readonly id: string
    /** Presentation kind: `secret` masks the input and keeps it out of logs. */
    readonly kind: 'text' | 'secret'
    /** What to ask. */
    readonly message: string
    /** Hint rendered inside an empty text input. */
    readonly placeholder?: string
  }
  | {
    /** Opaque id the answer calls address. */
    readonly id: string
    /** A choice among the offered options. */
    readonly kind: 'select'
    /** What to ask. */
    readonly message: string
    /** Choices; the answer carries the chosen option's id. */
    readonly options: readonly AuthorizationPromptOptionView[]
  }

/** How one attempt ended. */
export type AuthorizationOutcomeStatus = 'authorized' | 'cancelled' | 'failed'

/** One frame of an attempt's conversation, in ascending `seq` order. */
export type AuthorizationFrameView =
  | {
    readonly seq: number
    readonly kind: 'notice'
    /** What is happening, or what the human must do next. */
    readonly message: string
    /** A page the human must open to continue. */
    readonly url?: string
    /** A short code the human must enter on that page. */
    readonly code?: string
  }
  | {
    readonly seq: number
    readonly kind: 'prompt'
    /** The question, without its Host-side withdrawal signal. */
    readonly prompt: AuthorizationPromptView
  }
  | {
    readonly seq: number
    readonly kind: 'prompt-withdrawn'
    /** The prompt its flow withdrew while the attempt continues. */
    readonly promptId: string
  }
  | {
    readonly seq: number
    readonly kind: 'outcome'
    /** How the attempt ended. */
    readonly status: AuthorizationOutcomeStatus
    /** The flow's own diagnostic when it failed; absent otherwise. */
    readonly error?: string
  }

/** The frames of one attempt after a cursor, with its terminal state. */
export interface AuthorizationFramesView {
  /** Frames after the requested cursor, in ascending `seq` order. */
  readonly frames: readonly AuthorizationFrameView[]
  /** The cursor to send with the next poll. */
  readonly next: number
  /** True once the attempt settled; `outcome` is then present. */
  readonly done: boolean
  /** How the attempt ended; present only once `done` is true. */
  readonly outcome?: AuthorizationOutcomeStatus
}
