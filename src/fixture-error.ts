export type FixtureErrorCode =
  | 'FIXTURE_OPTIONS_INVALID'
  | 'FIXTURE_DOCUMENT_INVALID'
  | 'FIXTURE_REFERENCE_INVALID'
  | 'FIXTURE_REFERENCE_MISSING'
  | 'FIXTURE_REFERENCE_FIELD_MISSING'
  | 'FIXTURE_DEPENDENCY_CYCLE'
  | 'FIXTURE_TEMPLATE_FAILED'
  | 'FIXTURE_PROCESSOR_FAILED'
  | 'FIXTURE_CONNECTION_FAILED'
  | 'FIXTURE_WRITE_FAILED'

export type FixtureErrorContext = {
  stage: string
  file?: string
  fixtureName?: string
  entity?: string
  path?: string
}

const trustedFixtureErrors = new WeakSet<FixtureError>()

export class FixtureError extends Error {
  readonly code: FixtureErrorCode
  readonly stage: string
  readonly file?: string
  readonly fixtureName?: string
  readonly entity?: string
  readonly path?: string

  constructor(
    code: FixtureErrorCode,
    message: string,
    context: FixtureErrorContext,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'FixtureError'
    this.code = code
    this.stage = context.stage
    this.file = context.file
    this.fixtureName = context.fixtureName
    this.entity = context.entity
    this.path = context.path
  }
}

export function createFixtureError(
  code: FixtureErrorCode,
  message: string,
  context: FixtureErrorContext,
  cause?: unknown,
): FixtureError {
  return markFixtureErrorTrusted(
    new FixtureError(code, message, context, cause),
  )
}

export function markFixtureErrorTrusted<T extends FixtureError>(error: T): T {
  trustedFixtureErrors.add(error)
  return Object.freeze(error)
}

export function isTrustedFixtureError(error: unknown): error is FixtureError {
  return error instanceof FixtureError && trustedFixtureErrors.has(error)
}

export function wrapFixtureError(
  error: unknown,
  code: FixtureErrorCode,
  message: string,
  context: FixtureErrorContext,
): FixtureError {
  if (isTrustedFixtureError(error)) {
    return createFixtureError(
      error.code,
      error.message,
      {
        stage: error.stage || context.stage,
        file: error.file ?? context.file,
        fixtureName: error.fixtureName ?? context.fixtureName,
        entity: error.entity ?? context.entity,
        path: error.path ?? context.path,
      },
      error.cause,
    )
  }
  return createFixtureError(code, message, context, error)
}

export function appendFixturePath(path: string, part: string | number): string {
  const token = String(part).replaceAll('~', '~0').replaceAll('/', '~1')
  return `${path}/${token}`
}
