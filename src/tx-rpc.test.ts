import { describe, expect, it, vi } from "vitest";
import {
  createRpcTxSubmitter,
  RateLimitError,
  RpcRateLimitError,
  RpcTransactionError,
  TokenBucket,
} from "./tx-rpc";
import { xdr } from "@stellar/stellar-sdk";

describe("TokenBucket", () => {
  it("allows burst calls up to bucket size then rejects", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1 / 1000, () => now);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills tokens over time", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 2 / 1000, () => now);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    now = 500;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("calculates exact ms until next token from bucket state", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 1 / 1000, () => now);

    // Initial state: token available
    expect(bucket.msUntilNextToken()).toBe(0);
    expect(bucket.tryConsume()).toBe(true);

    // Empty: needs 1 full token at 1 token/sec (1/1000 per ms) -> 1000ms
    expect(bucket.msUntilNextToken()).toBe(1000);

    // After 400ms: has 0.4 tokens, deficit is 0.6 -> 600ms
    now = 400;
    expect(bucket.msUntilNextToken()).toBe(600);

    // After 1000ms: refilled
    now = 1000;
    expect(bucket.msUntilNextToken()).toBe(0);
  });

  it("returns Infinity for zero refill rate when bucket is empty", () => {
    const bucket = new TokenBucket(0, 0, () => 0);
    expect(bucket.msUntilNextToken()).toBe(Infinity);
  });
});

describe("createRpcTxSubmitter — rate limiting & shared buckets (#422)", () => {
  it("rejects excess submissions before hitting the network with actionable retryAfterMs", async () => {
    let now = 0;
    const sendTransaction = vi.fn();
    const bucket = new TokenBucket(1, 1 / 1000, () => now);
    const submitter = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      bucket,
      server: { sendTransaction } as never,
    });

    sendTransaction.mockResolvedValue({ hash: "tx_hash_1" });
    await expect(submitter.submitTransaction("AAAA")).resolves.toEqual({ hash: "tx_hash_1" });

    // Second call exceeds rate limit
    let caught: RateLimitError | undefined;
    try {
      await submitter.submitTransaction("AAAA");
    } catch (e) {
      caught = e as RateLimitError;
    }

    expect(caught).toBeInstanceOf(RateLimitError);
    expect(caught?.retryAfterMs).toBe(1000);
    expect(caught?.retryAfter).toBe(1);
    expect(caught?.retryable).toBe(true);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("two submitters sharing one bucket exhaust it together", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ hash: "shared_hash" });
    const sharedBucket = new TokenBucket(1, 0, () => 0); // 1 token capacity, no refill

    const submitter1 = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      bucket: sharedBucket,
      server: { sendTransaction } as never,
    });
    const submitter2 = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      bucket: sharedBucket,
      server: { sendTransaction } as never,
    });

    // Submitter 1 uses the only token
    await expect(submitter1.submitTransaction("TX1")).resolves.toEqual({ hash: "shared_hash" });

    // Submitter 2 is immediately rate limited by the same shared bucket
    await expect(submitter2.submitTransaction("TX2")).rejects.toBeInstanceOf(RateLimitError);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("two submitters with separate configs do not exhaust each other's buckets", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ hash: "hash" });

    const submitter1 = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      rateLimit: { bucketSize: 1, refillRate: 0 },
      server: { sendTransaction } as never,
    });
    const submitter2 = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      rateLimit: { bucketSize: 1, refillRate: 0 },
      server: { sendTransaction } as never,
    });

    // Both succeed independently
    await expect(submitter1.submitTransaction("TX1")).resolves.toEqual({ hash: "hash" });
    await expect(submitter2.submitTransaction("TX2")).resolves.toEqual({ hash: "hash" });
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("throws when both bucket and rateLimit config are provided", () => {
    const bucket = new TokenBucket(1, 1);
    expect(() =>
      createRpcTxSubmitter({
        rpcUrl: "https://rpc.test",
        bucket,
        rateLimit: { bucketSize: 1, refillRate: 1 },
      }),
    ).toThrow(/Cannot pass both `bucket` and `rateLimit`/);
  });
});

describe("createRpcTxSubmitter — retry-after & typed error handling (#423)", () => {
  it("handles upstream HTTP 429 rate limit distinctly from transaction errors", async () => {
    const error429 = Object.assign(new Error("Request failed with status code 429"), {
      status: 429,
      response: {
        status: 429,
        headers: { "retry-after": "3" },
      },
    });

    const sendTransaction = vi.fn().mockRejectedValue(error429);
    const submitter = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      server: { sendTransaction } as never,
    });

    let caught: RpcRateLimitError | undefined;
    try {
      await submitter.submitTransaction("AAAA");
    } catch (e) {
      caught = e as RpcRateLimitError;
    }

    expect(caught).toBeInstanceOf(RpcRateLimitError);
    expect(caught?.status).toBe(429);
    expect(caught?.retryable).toBe(true);
    expect(caught?.retryAfterMs).toBe(3000);
    expect(caught?.retryAfter).toBe(3);
  });

  it("handles upstream TRY_AGAIN_LATER response status as retryable rate limit", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({
      status: "TRY_AGAIN_LATER",
      hash: "",
    });
    const submitter = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      server: { sendTransaction } as never,
    });

    let caught: RpcRateLimitError | undefined;
    try {
      await submitter.submitTransaction("AAAA");
    } catch (e) {
      caught = e as RpcRateLimitError;
    }

    expect(caught).toBeInstanceOf(RpcRateLimitError);
    expect(caught?.retryable).toBe(true);
  });

  it("throws typed RpcTransactionError on status ERROR with decoded sequence error", async () => {
    const errorResult = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("100"),
      result: xdr.TransactionResultResult.txBadSeq(),
      ext: new xdr.TransactionResultExt(0),
    });

    const sendTransaction = vi.fn().mockResolvedValue({
      status: "ERROR",
      errorResult,
    });
    const submitter = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      server: { sendTransaction } as never,
    });

    let caught: RpcTransactionError | undefined;
    try {
      await submitter.submitTransaction("AAAA");
    } catch (e) {
      caught = e as RpcTransactionError;
    }

    expect(caught).toBeInstanceOf(RpcTransactionError);
    expect(caught?.status).toBe("ERROR");
    expect(caught?.resultCode).toBe("txBadSeq");
    expect(caught?.retryable).toBe(false);
    expect(caught?.errorResult).toBe(errorResult);
    expect(caught?.errorResultXdr).toBe(errorResult.toXDR("base64"));
  });

  it("throws typed RpcTransactionError on status ERROR with decoded insufficient fee error", async () => {
    const errorResult = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("50"),
      result: xdr.TransactionResultResult.txInsufficientFee(),
      ext: new xdr.TransactionResultExt(0),
    });

    const sendTransaction = vi.fn().mockResolvedValue({
      status: "ERROR",
      errorResult,
    });
    const submitter = createRpcTxSubmitter({
      rpcUrl: "https://rpc.test",
      server: { sendTransaction } as never,
    });

    let caught: RpcTransactionError | undefined;
    try {
      await submitter.submitTransaction("AAAA");
    } catch (e) {
      caught = e as RpcTransactionError;
    }

    expect(caught).toBeInstanceOf(RpcTransactionError);
    expect(caught?.resultCode).toBe("txInsufficientFee");
    expect(caught?.retryable).toBe(false);
  });
});
