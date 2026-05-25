export interface MetricsSnapshot {
  httpInFlight: number;
  httpRequestsTotal: number;
  generationRequestsTotal: number;
  generationFailoversTotal: number;
  toolCallsTotal: number;
  promptCharsTotal: number;
  completionCharsTotal: number;
  estimatedPromptTokensTotal: number;
  estimatedCompletionTokensTotal: number;
  poolActiveAccounts: number;
  poolCooldownAccounts: number;
  poolDeletedAccounts: number;
  poolTotalAccounts: number;
  poolBusyAccounts: number;
  requestDurationBuckets: number[];
  requestDurationCounts: number[];
  requestDurationSum: number;
}

const DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];

export class MetricsRegistry {
  private httpInFlight = 0;
  private httpRequestsTotal = 0;
  private generationRequestsTotal = 0;
  private generationFailoversTotal = 0;
  private toolCallsTotal = 0;
  private promptCharsTotal = 0;
  private completionCharsTotal = 0;
  private estimatedPromptTokensTotal = 0;
  private estimatedCompletionTokensTotal = 0;
  private poolActiveAccounts = 0;
  private poolCooldownAccounts = 0;
  private poolDeletedAccounts = 0;
  private poolTotalAccounts = 0;
  private poolBusyAccounts = 0;
  private readonly requestDurationCounts = new Array<number>(DURATION_BUCKETS.length).fill(0);
  private requestDurationSum = 0;

  public beginHttpRequest(): () => void {
    this.httpInFlight += 1;
    const start = performance.now();

    return () => {
      const elapsedSeconds = Math.max(0, (performance.now() - start) / 1000);
      this.httpInFlight = Math.max(0, this.httpInFlight - 1);
      this.httpRequestsTotal += 1;
      this.observeDuration(elapsedSeconds);
    };
  }

  public recordGeneration(prompt: string, completion: string): void {
    this.generationRequestsTotal += 1;
    this.promptCharsTotal += prompt.length;
    this.completionCharsTotal += completion.length;
    this.estimatedPromptTokensTotal += estimateTokens(prompt);
    this.estimatedCompletionTokensTotal += estimateTokens(completion);
  }

  public recordFailover(): void {
    this.generationFailoversTotal += 1;
  }

  public recordToolCall(): void {
    this.toolCallsTotal += 1;
  }

  public setPoolState(input: {
    active: number;
    cooldown: number;
    deleted: number;
    total: number;
    busy: number;
  }): void {
    this.poolActiveAccounts = input.active;
    this.poolCooldownAccounts = input.cooldown;
    this.poolDeletedAccounts = input.deleted;
    this.poolTotalAccounts = input.total;
    this.poolBusyAccounts = input.busy;
  }

  public renderPrometheus(): string {
    const lines = [
      "# HELP anything2api_http_inflight_requests Current in-flight HTTP requests",
      "# TYPE anything2api_http_inflight_requests gauge",
      `anything2api_http_inflight_requests ${this.httpInFlight}`,
      "# HELP anything2api_http_requests_total Total HTTP requests served",
      "# TYPE anything2api_http_requests_total counter",
      `anything2api_http_requests_total ${this.httpRequestsTotal}`,
      "# HELP anything2api_generation_requests_total Total generation requests",
      "# TYPE anything2api_generation_requests_total counter",
      `anything2api_generation_requests_total ${this.generationRequestsTotal}`,
      "# HELP anything2api_generation_failovers_total Total automatic account failovers",
      "# TYPE anything2api_generation_failovers_total counter",
      `anything2api_generation_failovers_total ${this.generationFailoversTotal}`,
      "# HELP anything2api_tool_calls_total Total emitted tool calls",
      "# TYPE anything2api_tool_calls_total counter",
      `anything2api_tool_calls_total ${this.toolCallsTotal}`,
      "# HELP anything2api_prompt_chars_total Total prompt characters",
      "# TYPE anything2api_prompt_chars_total counter",
      `anything2api_prompt_chars_total ${this.promptCharsTotal}`,
      "# HELP anything2api_completion_chars_total Total completion characters",
      "# TYPE anything2api_completion_chars_total counter",
      `anything2api_completion_chars_total ${this.completionCharsTotal}`,
      "# HELP anything2api_estimated_prompt_tokens_total Estimated prompt tokens",
      "# TYPE anything2api_estimated_prompt_tokens_total counter",
      `anything2api_estimated_prompt_tokens_total ${this.estimatedPromptTokensTotal}`,
      "# HELP anything2api_estimated_completion_tokens_total Estimated completion tokens",
      "# TYPE anything2api_estimated_completion_tokens_total counter",
      `anything2api_estimated_completion_tokens_total ${this.estimatedCompletionTokensTotal}`,
      "# HELP anything2api_pool_active_accounts Active pool accounts",
      "# TYPE anything2api_pool_active_accounts gauge",
      `anything2api_pool_active_accounts ${this.poolActiveAccounts}`,
      "# HELP anything2api_pool_cooldown_accounts Cooldown pool accounts",
      "# TYPE anything2api_pool_cooldown_accounts gauge",
      `anything2api_pool_cooldown_accounts ${this.poolCooldownAccounts}`,
      "# HELP anything2api_pool_deleted_accounts Deleted pool accounts",
      "# TYPE anything2api_pool_deleted_accounts gauge",
      `anything2api_pool_deleted_accounts ${this.poolDeletedAccounts}`,
      "# HELP anything2api_pool_total_accounts Total pool accounts",
      "# TYPE anything2api_pool_total_accounts gauge",
      `anything2api_pool_total_accounts ${this.poolTotalAccounts}`,
      "# HELP anything2api_pool_busy_accounts Busy pool accounts",
      "# TYPE anything2api_pool_busy_accounts gauge",
      `anything2api_pool_busy_accounts ${this.poolBusyAccounts}`,
      "# HELP anything2api_http_request_duration_seconds HTTP request duration histogram",
      "# TYPE anything2api_http_request_duration_seconds histogram",
    ];

    let cumulative = 0;
    for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
      cumulative += this.requestDurationCounts[index] ?? 0;
      lines.push(`anything2api_http_request_duration_seconds_bucket{le="${DURATION_BUCKETS[index]}"} ${cumulative}`);
    }
    lines.push(`anything2api_http_request_duration_seconds_bucket{le="+Inf"} ${this.httpRequestsTotal}`);
    lines.push(`anything2api_http_request_duration_seconds_sum ${this.requestDurationSum}`);
    lines.push(`anything2api_http_request_duration_seconds_count ${this.httpRequestsTotal}`);

    return `${lines.join("\n")}\n`;
  }

  private observeDuration(seconds: number): void {
    this.requestDurationSum += seconds;
    for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
      const bucket = DURATION_BUCKETS[index] ?? Number.POSITIVE_INFINITY;
      if (seconds <= bucket) {
        this.requestDurationCounts[index] = (this.requestDurationCounts[index] ?? 0) + 1;
      }
    }
  }
}

function estimateTokens(input: string): number {
  if (!input) {
    return 0;
  }
  return Math.max(1, Math.ceil(input.length / 4));
}
