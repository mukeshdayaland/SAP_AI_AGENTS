/**
 * Minimal in-process metrics registry with Prometheus text exposition.
 * Metric names follow OpenTelemetry semantic-convention style so an
 * OTel collector (Prometheus receiver) can scrape `/metrics` unchanged.
 */

type Labels = Record<string, string>;

const labelKey = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',');

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number) {
    this.values.set(labelKey(labels), value);
  }
}

const DEFAULT_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

class Histogram {
  readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = DEFAULT_BUCKETS_MS,
  ) {}
  observe(labels: Labels, value: number) {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = new Counter(name, help)));
    return c;
  }

  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) this.gauges.set(name, (g = new Gauge(name, help)));
    return g;
  }

  histogram(name: string, help: string, bounds?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) this.histograms.set(name, (h = new Histogram(name, help, bounds)));
    return h;
  }

  /** Prometheus text format 0.0.4. */
  render(): string {
    const out: string[] = [];
    const wrap = (k: string) => (k ? `{${k}}` : '');
    for (const c of this.counters.values()) {
      out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      for (const [k, v] of c.values) out.push(`${c.name}${wrap(k)} ${v}`);
    }
    for (const g of this.gauges.values()) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const [k, v] of g.values) out.push(`${g.name}${wrap(k)} ${v}`);
    }
    for (const h of this.histograms.values()) {
      out.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
      for (const [k, s] of h.series) {
        const sep = k ? ',' : '';
        h.bounds.forEach((b, i) => out.push(`${h.name}_bucket{${k}${sep}le="${b}"} ${s.buckets[i]}`));
        out.push(`${h.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
        out.push(`${h.name}_sum${wrap(k)} ${s.sum}`, `${h.name}_count${wrap(k)} ${s.count}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}

/** Process-wide default registry. */
export const metrics = new MetricsRegistry();

export const M = {
  httpRequests: () => metrics.counter('prowess_http_requests_total', 'HTTP requests by route and status'),
  httpDuration: () => metrics.histogram('prowess_http_request_duration_ms', 'HTTP request latency'),
  llmRequests: () => metrics.counter('prowess_llm_requests_total', 'LLM requests by provider and outcome'),
  llmDuration: () => metrics.histogram('prowess_llm_request_duration_ms', 'LLM end-to-end latency'),
  llmTokens: () => metrics.counter('prowess_llm_tokens_total', 'LLM token consumption by direction'),
  providerUp: () => metrics.gauge('prowess_llm_provider_up', 'Provider availability (1 = healthy)'),
  toolCalls: () => metrics.counter('prowess_tool_calls_total', 'MCP tool calls by tool and outcome'),
  toolDuration: () => metrics.histogram('prowess_tool_call_duration_ms', 'MCP tool latency'),
  sapDuration: () => metrics.histogram('prowess_sap_request_duration_ms', 'SAP backend latency'),
  errors: () => metrics.counter('prowess_errors_total', 'Errors by category'),
};
