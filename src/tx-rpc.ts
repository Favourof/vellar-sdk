import {
  Networks,
  rpc,
  StrKey,
  type FeeBumpTransaction,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { TxStatus, TxStatusReader } from "./tx-status";

// RPC-backed pieces of the payment flow (subpath export — see rpc.ts).
//
// CONCURRENCY & SCOPE NOTE:
// A shared TokenBucket instance passed to multiple submitters is PER-PROCESS ONLY
// (in-memory state within the current runtime). Multiple browser tabs, web workers,
// or distributed service instances do NOT share this bucket and will each enforce
// their own local limits independently. Applications operating across multiple tabs
// or processes that require a global transaction rate limit must coordinate using a
// shared backing store (such as BroadcastChannel, SharedWorker, or Redis).

/** Accepts classic (G...) and contract (C...) addresses. */
export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

export function createRpcTxStatusReader(options: { rpcUrl: string }): TxStatusReader {
  const server = new rpc.Server(options.rpcUrl);
  return {
    async getStatus(hash): Promise<TxStatus> {
      const res = await server.getTransaction(hash);
      switch (res.status) {
        case rpc.Api.GetTransactionStatus.SUCCESS:
          return "success";
        case rpc.Api.GetTransactionStatus.FAILED:
          return "failed";
        default:
          // NOT_FOUND: not yet included in a ledger.
          return "pending";
      }
    },
  };
}

/** Thrown when an RPC submission is rejected by the client-side rate limiter. */
export class RateLimitError extends Error {
  /** Milliseconds until at least one token will be available in the bucket. */
  readonly retryAfterMs: number;
  /** Always true: rate-limit rejections are transient and retryable after backoff. */
  readonly retryable: boolean = true;

  constructor(message = "RPC submission rate limit exceeded", retryAfterMs = 0) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }

  /** Approximate retry-after in whole seconds (rounded up). */
  get retryAfter(): number {
    return Math.ceil(this.retryAfterMs / 1000);
  }
}

/**
 * Thrown when an upstream RPC provider returns HTTP 429 Too Many Requests or TRY_AGAIN_LATER.
 * Distinct from transaction-level errors: this indicates provider backpressure and is retryable.
 */
export class RpcRateLimitError extends RateLimitError {
  readonly status: number = 429;

  constructor(
    message = "Upstream RPC rate limit exceeded (HTTP 429)",
    retryAfterMs = 0,
  ) {
    super(message, retryAfterMs);
    this.name = "RpcRateLimitError";
  }
}

/**
 * Thrown when the RPC accepts the request but rejects the transaction itself with status ERROR.
 * Exposes the decoded transaction result code (e.g. txBadSeq, txInsufficientFee) so callers can
 * distinguish operational issues without parsing raw XDR.
 *
 * Terminal (retryable = false): the network evaluated the transaction and rejected it; resubmitting
 * the identical payload without fixing the underlying sequence/fee/auth will produce the same error.
 */
export class RpcTransactionError extends Error {
  readonly status: string = "ERROR";
  readonly errorResult?: xdr.TransactionResult;
  readonly errorResultXdr?: string;
  readonly resultCode?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: {
      errorResult?: xdr.TransactionResult;
      errorResultXdr?: string;
      resultCode?: string;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "RpcTransactionError";
    this.errorResult = options?.errorResult;
    this.errorResultXdr = options?.errorResultXdr;
    this.resultCode = options?.resultCode;
    this.retryable = options?.retryable ?? false;
  }
}

export interface RpcRateLimitOptions {
  /** Maximum tokens the bucket can hold. */
  bucketSize: number;
  /** Tokens added per second. */
  refillRate: number;
}

export interface RpcTxSubmitterOptions {
  rpcUrl: string;
  networkPassphrase?: string;
  /** When set, submission calls are guarded by a newly constructed token bucket. */
  rateLimit?: RpcRateLimitOptions;
  /**
   * An already-constructed TokenBucket instance shared across submitters in this process.
   * Mutually exclusive with `rateLimit`.
   */
  bucket?: TokenBucket;
  /** Injected RPC server (for tests). Defaults to a new rpc.Server(rpcUrl). */
  server?: Pick<rpc.Server, "sendTransaction">;
}

export interface RpcTxSubmitter {
  submitTransaction(signedXdr: string): Promise<{ hash: string }>;
}

/** Token bucket rate limiter. Can be instantiated once and shared across submitters. */
export class TokenBucket {
  #tokens: number;
  #lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = capacity;
    this.#lastRefill = now();
  }

  /** Returns true and consumes one token when allowed; false when over limit. */
  tryConsume(): boolean {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Milliseconds until at least one token is available in this bucket,
   * computed from the current token deficit and refill rate.
   * Returns 0 if at least one token is already available.
   */
  msUntilNextToken(): number {
    this.#refill();
    if (this.#tokens >= 1) return 0;
    if (this.refillPerMs <= 0) return Infinity;
    const deficit = 1 - this.#tokens;
    return Math.ceil(deficit / this.refillPerMs);
  }

  #refill(): void {
    const t = this.now();
    const elapsed = t - this.#lastRefill;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillPerMs);
    this.#lastRefill = t;
  }
}

function isUpstreamRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.status === 429 || e.statusCode === 429) return true;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && (resp.status === 429 || resp.statusCode === 429)) return true;
  if (
    typeof e.message === "string" &&
    (e.message.includes("429") || /rate limit/i.test(e.message))
  ) {
    return true;
  }
  return false;
}

function extractRetryAfterMs(err: unknown): number {
  if (!err || typeof err !== "object") return 0;
  const e = err as Record<string, unknown>;
  const resp = e.response as Record<string, unknown> | undefined;
  const headers = (resp?.headers ?? e.headers) as Record<string, unknown> | undefined;
  if (headers) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string" || typeof raw === "number") {
      const num = Number(raw);
      if (!Number.isNaN(num)) {
        return num * 1000;
      }
    }
  }
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  return 0;
}

export function createRpcTxSubmitter(options: RpcTxSubmitterOptions): RpcTxSubmitter {
  if (options.bucket && options.rateLimit) {
    throw new Error(
      "Cannot pass both `bucket` and `rateLimit` options to createRpcTxSubmitter; provide either a shared bucket or a rateLimit config.",
    );
  }

  const server = options.server ?? new rpc.Server(options.rpcUrl);
  const limiter =
    options.bucket ??
    (options.rateLimit &&
      new TokenBucket(
        options.rateLimit.bucketSize,
        options.rateLimit.refillRate / 1000,
      ));

  return {
    async submitTransaction(signedXdr) {
      if (limiter && !limiter.tryConsume()) {
        const retryAfterMs = limiter.msUntilNextToken();
        throw new RateLimitError(
          `RPC submission rate limit exceeded; retry after ${retryAfterMs}ms`,
          retryAfterMs,
        );
      }

      let tx: Transaction | FeeBumpTransaction;
      try {
        tx = TransactionBuilder.fromXDR(
          signedXdr,
          options.networkPassphrase ?? Networks.TESTNET,
        );
      } catch {
        tx = { toXDR: () => signedXdr } as unknown as Transaction;
      }

      let res: rpc.Api.SendTransactionResponse;
      try {
        res = await server.sendTransaction(tx);
      } catch (err: unknown) {
        if (isUpstreamRateLimit(err)) {
          const retryAfterMs = extractRetryAfterMs(err);
          throw new RpcRateLimitError(
            "Upstream RPC rate limit exceeded (HTTP 429)",
            retryAfterMs,
          );
        }
        throw err;
      }

      if (res.status === "TRY_AGAIN_LATER") {
        throw new RpcRateLimitError("Upstream RPC server is busy; try again later");
      }

      if (res.status === "ERROR") {
        let errorResult = res.errorResult;
        let errorResultXdr: string | undefined;
        if (errorResult) {
          try {
            errorResultXdr = errorResult.toXDR("base64");
          } catch {
            // ignore serialization error
          }
        } else if ((res as { errorResultXdr?: string }).errorResultXdr) {
          errorResultXdr = (res as { errorResultXdr?: string }).errorResultXdr;
          try {
            errorResult = xdr.TransactionResult.fromXDR(errorResultXdr!, "base64");
          } catch {
            // ignore parse failure
          }
        }

        const resultCode = errorResult?.result()?.switch()?.name;
        const message = resultCode
          ? `sendTransaction failed with ${resultCode}: ${errorResultXdr ?? "unknown error"}`
          : (errorResultXdr ?? "sendTransaction failed");

        throw new RpcTransactionError(message, {
          errorResult,
          errorResultXdr,
          resultCode,
          retryable: false,
        });
      }

      if (!res.hash) {
        throw new Error("sendTransaction returned no hash");
      }
      return { hash: res.hash };
    },
  };
}
