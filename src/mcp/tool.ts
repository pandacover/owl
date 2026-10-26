import { Cause, Effect, Schema } from "effect"
import { McpServer } from "effect/ai"
import { CallToolResult, ImageContent, TextContent, Tool as McpTool } from "effect/ai/McpSchema"
import { getJsonSchemaFromSchema } from "effect/ai/Tool"
import { Context } from "effect"

/**
 * Registers MCP tools whose results mix readable text and images. The
 * toolkit helpers in effect/ai return JSON only, which costs agents more
 * tokens to read and cannot carry frames.
 */

export interface ToolOutput {
  readonly text: string
  readonly images?: ReadonlyArray<{ readonly caption?: string; readonly data: Uint8Array; readonly mimeType: string }>
}

export interface ToolSpec<S extends Schema.Top, R> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly params: S
  readonly readOnly?: boolean
  readonly destructive?: boolean
  readonly idempotent?: boolean
  readonly openWorld?: boolean
  readonly handle: (input: S["Type"]) => Effect.Effect<ToolOutput | string, { readonly message: string; readonly _tag: string }, R>
}

const errorResult = (message: string) =>
  new CallToolResult({ isError: true, content: [TextContent.make({ text: message })] })

/** Schema issues as one short line per problem, phrased for an agent. */
const formatIssue = (error: Schema.SchemaError) =>
  `Invalid arguments: ${error.message.split("\n").slice(0, 12).join(" ").replace(/\s+/g, " ")}`

/**
 * Tool schemas are read by the model on every turn, so they are kept small:
 * no default safe-integer bounds, no `additionalProperties: true`, and
 * `anyOf` of plain types written as a type list.
 */
export const compactSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(compactSchema)
  if (node === null || typeof node !== "object") return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if ((key === "minimum" || key === "maximum") && Math.abs(value as number) === Number.MAX_SAFE_INTEGER) continue
    if (key === "additionalProperties" && value === true) continue
    out[key] = compactSchema(value)
  }
  const anyOf = out["anyOf"]
  if (
    Array.isArray(anyOf) &&
    anyOf.every((x) => typeof x === "object" && x !== null && Object.keys(x).length === 1 && typeof (x as { type?: unknown }).type === "string")
  ) {
    delete out["anyOf"]
    out["type"] = anyOf.map((x) => (x as { type: string }).type)
  }
  return out
}

/** MCP needs an object root. An empty struct compiles to a non-object schema, so it gets a plain one. */
const toInputSchema = (schema: Schema.Top): McpTool["inputSchema"] => {
  const json = compactSchema(getJsonSchemaFromSchema(schema)) as Record<string, unknown>
  if (json["type"] === "object") return json as McpTool["inputSchema"]
  return { type: "object", properties: {} }
}

export const registerTool = <S extends Schema.Top & { readonly DecodingServices: never }, R>(spec: ToolSpec<S, R>) =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    const context = yield* Effect.context<R>()
    const decode = Schema.decodeUnknownEffect(spec.params)
    const inputSchema = toInputSchema(spec.params)
    yield* server.addTool({
      tool: new McpTool({
        name: spec.name,
        title: spec.title,
        description: spec.description,
        inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly ?? false,
          destructiveHint: spec.destructive ?? false,
          idempotentHint: spec.idempotent ?? false,
          openWorldHint: spec.openWorld ?? false
        }
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        decode(payload ?? {}).pipe(
          Effect.mapError((error) => ({ _tag: "Invalid", message: formatIssue(error) })),
          Effect.flatMap((input) => spec.handle(input)),
          Effect.map((output) => {
            const out = typeof output === "string" ? { text: output } : output
            const content: Array<TextContent | ImageContent> = [TextContent.make({ text: out.text })]
            for (const image of out.images ?? []) {
              if (image.caption) content.push(TextContent.make({ text: image.caption }))
              content.push(ImageContent.make({ data: image.data, mimeType: image.mimeType }))
            }
            return new CallToolResult({ content })
          }),
          Effect.catch((error) =>
            Effect.succeed(errorResult(error._tag === "OwlError" || error._tag === "Invalid" ? error.message : `${error._tag}: ${error.message}`))
          ),
          Effect.catchCause((cause) =>
            Effect.logError(`Tool ${spec.name} crashed`, cause).pipe(
              Effect.as(errorResult(`Internal error in ${spec.name}: ${Cause.pretty(cause).split("\n")[0]}`))
            )
          ),
          Effect.provideContext(context)
        )
    })
  })
