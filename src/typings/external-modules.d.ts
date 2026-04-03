/**
 * Type declarations for external packages not installed locally.
 * These are optional/conditional dependencies in the Claude Code codebase.
 */

// AWS SDK modules (optional, for Bedrock provider)
declare module '@anthropic-ai/bedrock-sdk' {
  export class AnthropicBedrock {
    constructor(options?: Record<string, unknown>)
    messages: {
      create(params: Record<string, unknown>): Promise<unknown>
    }
    beta: Record<string, unknown>
  }
  export default AnthropicBedrock
}

declare module '@anthropic-ai/foundry-sdk' {
  export class AnthropicFoundry {
    constructor(options?: Record<string, unknown>)
    messages: {
      create(params: Record<string, unknown>): Promise<unknown>
    }
    beta: Record<string, unknown>
  }
  export default AnthropicFoundry
}

declare module '@anthropic-ai/vertex-sdk' {
  export class AnthropicVertex {
    constructor(options?: Record<string, unknown>)
    messages: {
      create(params: Record<string, unknown>): Promise<unknown>
    }
    beta: Record<string, unknown>
  }
  export default AnthropicVertex
}

declare module '@aws-sdk/client-bedrock' {
  export class BedrockClient {
    constructor(options?: Record<string, unknown>)
    send(command: unknown): Promise<unknown>
  }
  export class ListFoundationModelsCommand {
    constructor(input?: Record<string, unknown>)
  }
}

declare module '@aws-sdk/client-sts' {
  export class STSClient {
    constructor(options?: Record<string, unknown>)
    send(command: unknown): Promise<unknown>
  }
  export class GetCallerIdentityCommand {
    constructor(input?: Record<string, unknown>)
  }
}

declare module '@aws-sdk/credential-providers' {
  export function fromIni(options?: Record<string, unknown>): unknown
  export function fromEnv(): unknown
  export function fromSSO(options?: Record<string, unknown>): unknown
}

declare module '@azure/identity' {
  export class DefaultAzureCredential {
    constructor(options?: Record<string, unknown>)
    getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number }>
  }
}

// OpenTelemetry exporters (optional)
declare module '@opentelemetry/exporter-logs-otlp-grpc' {
  export class OTLPLogExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-logs-otlp-http' {
  export class OTLPLogExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-logs-otlp-proto' {
  export class OTLPLogExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-metrics-otlp-grpc' {
  export class OTLPMetricExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-metrics-otlp-http' {
  export class OTLPMetricExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-metrics-otlp-proto' {
  export class OTLPMetricExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-prometheus' {
  export class PrometheusExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-trace-otlp-grpc' {
  export class OTLPTraceExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-trace-otlp-http' {
  export class OTLPTraceExporter {
    constructor(options?: Record<string, unknown>)
  }
}

declare module '@opentelemetry/exporter-trace-otlp-proto' {
  export class OTLPTraceExporter {
    constructor(options?: Record<string, unknown>)
  }
}

// Native addon modules (optional)
declare module 'audio-capture-napi' {
  const mod: Record<string, unknown>
  export default mod
}

declare module 'image-processor-napi' {
  const mod: Record<string, unknown>
  export default mod
}

// Optional packages
declare module 'cacache' {
  export function get(cachePath: string, key: string): Promise<{ data: Buffer; metadata: unknown }>
  export function put(cachePath: string, key: string, data: Buffer, opts?: Record<string, unknown>): Promise<string>
  export function rm(cachePath: string, key: string): Promise<void>
  export function ls(cachePath: string): Promise<Record<string, unknown>>
}

declare module 'cli-highlight' {
  export function highlight(code: string, options?: Record<string, unknown>): string
}

declare module 'plist' {
  export function parse(input: string): unknown
  export function build(obj: unknown): string
}

declare module 'sharp' {
  interface Sharp {
    resize(width?: number, height?: number, options?: Record<string, unknown>): Sharp
    toBuffer(): Promise<Buffer>
    metadata(): Promise<Record<string, unknown>>
    png(): Sharp
    jpeg(): Sharp
  }
  function sharp(input?: string | Buffer): Sharp
  export default sharp
}

declare module 'turndown' {
  class TurndownService {
    constructor(options?: Record<string, unknown>)
    turndown(html: string): string
    addRule(key: string, rule: Record<string, unknown>): this
  }
  export default TurndownService
}
