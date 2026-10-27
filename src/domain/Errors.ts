import { Schema } from "effect"

/**
 * Errors an agent can act on. The message is written for the agent: it says
 * what went wrong and what to do instead.
 */
export class OwlError extends Schema.TaggedError<OwlError>()("OwlError", {
  kind: Schema.Literals(["not_found", "invalid", "not_ready", "conflict", "external", "internal"]),
  message: Schema.String
}) {
  static notFound(message: string) {
    return new OwlError({ kind: "not_found", message })
  }
  static invalid(message: string) {
    return new OwlError({ kind: "invalid", message })
  }
  static notReady(message: string) {
    return new OwlError({ kind: "not_ready", message })
  }
  static conflict(message: string) {
    return new OwlError({ kind: "conflict", message })
  }
  static external(message: string) {
    return new OwlError({ kind: "external", message })
  }
  static internal(message: string) {
    return new OwlError({ kind: "internal", message })
  }
}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  op: Schema.String,
  key: Schema.String,
  message: Schema.String
}) {}

export class FfmpegError extends Schema.TaggedError<FfmpegError>()("FfmpegError", {
  message: Schema.String,
  stderr: Schema.String
}) {}

export class AiError extends Schema.TaggedError<AiError>()("AiError", {
  service: Schema.String,
  message: Schema.String
}) {}
