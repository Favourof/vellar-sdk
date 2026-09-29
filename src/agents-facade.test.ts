import { describe, expect, it, vi } from "vitest";
import {
  AgentsNotConfiguredError,
  AgentVerificationError,
  InvalidAgentInputError,
  createAgentsFacade,
  type AgentKeyRuntime,
  type AgentSignerReader,
} from "./agents-facade";

const AGENT_PK = "G".padEnd(56, "A");
const TOKEN = "C".padEnd(56, "B");
const SPENDING = "C".padEnd(56, "C");
const VERIFIED = "C".padEnd(56, "D");
const EXTRA_TOKEN = "C".padEnd(56, "E");

function stubRuntime() {
  const addAgentKey = vi.fn<AgentKeyRuntime["addAgentKey"]>(async () => ({ hash: "addhash" }));
  const removeAgentKey = vi.fn<AgentKeyRuntime["removeAgentKey"]>(async () => ({ hash: "rmhash" }));
  const resume = vi.fn<NonNullable<AgentKeyRuntime["resume"]>>(async () => {});
  const runtime: AgentKeyRuntime = { addAgentKey, removeAgentKey, resume };
  return { runtime, addAgentKey, removeAgentKey, resume };
}

function build(runtime?: AgentKeyRuntime, keyId?: string, signerReader?: AgentSignerReader) {
  return createAgentsFacade({
    requireSession: () => ({ accountId: "CWALLET", ...(keyId ? { keyId } : {}) }),
    runtime,
    signerReader,
  });
}

describe("wallet.agents.mint", () => {
  it("mints an agent key with the token grants and returns the hash", async () => {
    const { runtime, addAgentKey } = stubRuntime();
    const agents = build(runtime);
    const result = await agents.mint({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING, VERIFIED] }],
    });
    expect(result).toEqual({ hash: "addhash", publicKey: AGENT_PK });
    expect(addAgentKey).toHaveBeenCalledWith({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING, VERIFIED] }],
      store: "persistent",
    });
  });

  it("converts a Date expiry to unix seconds and echoes it back as ISO", async () => {
    const { runtime, addAgentKey } = stubRuntime();
    const agents = build(runtime);
    const future = new Date(Date.now() + 3_600_000);
    const result = await agents.mint({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING] }],
      expiresAt: future,
    });
    const passedSeconds = addAgentKey.mock.calls[0]?.[0]?.expirationSeconds ?? 0;
    expect(passedSeconds).toBe(Math.floor(future.getTime() / 1000));
    expect(result.expiresAt).toBe(new Date(passedSeconds * 1000).toISOString());
  });

  it("accepts a raw unix-seconds expiry", async () => {
    const { runtime, addAgentKey } = stubRuntime();
    const agents = build(runtime);
    const seconds = Math.floor(Date.now() / 1000) + 7200;
    await agents.mint({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING] }],
      expiresAt: seconds,
    });
    expect(addAgentKey.mock.calls[0]?.[0]?.expirationSeconds).toBe(seconds);
  });

  it("resumes the passkey session before minting when a keyId is present", async () => {
    const { runtime, resume } = stubRuntime();
    const agents = build(runtime, "mykeyid");
    await agents.mint({ publicKey: AGENT_PK, grants: [{ token: TOKEN, policies: [SPENDING] }] });
    expect(resume).toHaveBeenCalledWith("mykeyid");
  });

  it("throws AgentsNotConfiguredError when no runtime is wired", async () => {
    const agents = build(undefined);
    await expect(
      agents.mint({ publicKey: AGENT_PK, grants: [{ token: TOKEN, policies: [SPENDING] }] }),
    ).rejects.toBeInstanceOf(AgentsNotConfiguredError);
  });

  it("rejects a bad agent public key", async () => {
    const { runtime } = stubRuntime();
    const agents = build(runtime);
    await expect(
      agents.mint({ publicKey: "not-a-key", grants: [{ token: TOKEN, policies: [SPENDING] }] }),
    ).rejects.toBeInstanceOf(InvalidAgentInputError);
  });

  it("rejects an empty grants list", async () => {
    const { runtime } = stubRuntime();
    const agents = build(runtime);
    await expect(agents.mint({ publicKey: AGENT_PK, grants: [] })).rejects.toBeInstanceOf(
      InvalidAgentInputError,
    );
  });

  it("rejects a grant with no policies (no unrestricted grants via wallet.agents)", async () => {
    const { runtime } = stubRuntime();
    const agents = build(runtime);
    await expect(
      agents.mint({ publicKey: AGENT_PK, grants: [{ token: TOKEN, policies: [] }] }),
    ).rejects.toBeInstanceOf(InvalidAgentInputError);
  });

  it("rejects a non-contract token or policy id", async () => {
    const { runtime } = stubRuntime();
    const agents = build(runtime);
    await expect(
      agents.mint({ publicKey: AGENT_PK, grants: [{ token: "GBAD", policies: [SPENDING] }] }),
    ).rejects.toBeInstanceOf(InvalidAgentInputError);
    await expect(
      agents.mint({ publicKey: AGENT_PK, grants: [{ token: TOKEN, policies: ["GBAD"] }] }),
    ).rejects.toBeInstanceOf(InvalidAgentInputError);
  });

  it("rejects an expiry in the past", async () => {
    const { runtime } = stubRuntime();
    const agents = build(runtime);
    await expect(
      agents.mint({
        publicKey: AGENT_PK,
        grants: [{ token: TOKEN, policies: [SPENDING] }],
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toBeInstanceOf(InvalidAgentInputError);
  });
});

describe("wallet.agents.mint — on-chain read-back verification (#424)", () => {
  it("succeeds when on-chain state is an exact match for requested grants and policies", async () => {
    const { runtime } = stubRuntime();
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue({
        grants: [{ token: TOKEN, policies: [SPENDING, VERIFIED] }],
      }),
    };
    const agents = build(runtime, undefined, signerReader);

    const result = await agents.mint({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING, VERIFIED] }],
    });

    expect(result.hash).toBe("addhash");
    expect(signerReader.getSigner).toHaveBeenCalledWith(AGENT_PK, "CWALLET");
  });

  it("throws AgentVerificationError when minted key is absent entirely on-chain", async () => {
    const { runtime } = stubRuntime();
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue(null),
    };
    const agents = build(runtime, undefined, signerReader);

    let caught: AgentVerificationError | undefined;
    try {
      await agents.mint({
        publicKey: AGENT_PK,
        grants: [{ token: TOKEN, policies: [SPENDING] }],
      });
    } catch (e) {
      caught = e as AgentVerificationError;
    }

    expect(caught).toBeInstanceOf(AgentVerificationError);
    expect(caught?.direction).toBe("absent");
    expect(caught?.publicKey).toBe(AGENT_PK);
    expect(caught?.txHash).toBe("addhash");
    expect(caught?.message).toMatch(/was not found on-chain/);
  });

  it("detects a missing policy as MORE PERMISSIVE (dangerous) and warns of unintended authority", async () => {
    const { runtime } = stubRuntime();
    // On-chain state is missing VERIFIED policy co-signer
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue({
        grants: [{ token: TOKEN, policies: [SPENDING] }],
      }),
    };
    const agents = build(runtime, undefined, signerReader);

    let caught: AgentVerificationError | undefined;
    try {
      await agents.mint({
        publicKey: AGENT_PK,
        grants: [{ token: TOKEN, policies: [SPENDING, VERIFIED] }],
      });
    } catch (e) {
      caught = e as AgentVerificationError;
    }

    expect(caught).toBeInstanceOf(AgentVerificationError);
    expect(caught?.direction).toBe("more_permissive");
    expect(caught?.message).toMatch(/MORE PERMISSIVE/);
    expect(caught?.message).toMatch(/unintended authority/);
    expect(caught?.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`missing required policy co-signer on-chain: ${VERIFIED}`),
      ]),
    );
  });

  it("detects an extra token grant as MORE PERMISSIVE (dangerous) and names the grant", async () => {
    const { runtime } = stubRuntime();
    // On-chain state has an extra unexpected token grant
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue({
        grants: [
          { token: TOKEN, policies: [SPENDING] },
          { token: EXTRA_TOKEN, policies: [SPENDING] },
        ],
      }),
    };
    const agents = build(runtime, undefined, signerReader);

    let caught: AgentVerificationError | undefined;
    try {
      await agents.mint({
        publicKey: AGENT_PK,
        grants: [{ token: TOKEN, policies: [SPENDING] }],
      });
    } catch (e) {
      caught = e as AgentVerificationError;
    }

    expect(caught).toBeInstanceOf(AgentVerificationError);
    expect(caught?.direction).toBe("more_permissive");
    expect(caught?.message).toMatch(/MORE PERMISSIVE/);
    expect(caught?.message).toMatch(/unintended authority/);
    expect(caught?.differences).toEqual(
      expect.arrayContaining([expect.stringContaining(`Extra token grant on-chain: ${EXTRA_TOKEN}`)]),
    );
  });

  it("detects a missing token grant as LESS PERMISSIVE", async () => {
    const { runtime } = stubRuntime();
    // On-chain state has fewer token grants than requested
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue({
        grants: [{ token: TOKEN, policies: [SPENDING] }],
      }),
    };
    const agents = build(runtime, undefined, signerReader);

    let caught: AgentVerificationError | undefined;
    try {
      await agents.mint({
        publicKey: AGENT_PK,
        grants: [
          { token: TOKEN, policies: [SPENDING] },
          { token: EXTRA_TOKEN, policies: [SPENDING] },
        ],
      });
    } catch (e) {
      caught = e as AgentVerificationError;
    }

    expect(caught).toBeInstanceOf(AgentVerificationError);
    expect(caught?.direction).toBe("less_permissive");
    expect(caught?.message).toMatch(/LESS PERMISSIVE/);
    expect(caught?.differences).toEqual(
      expect.arrayContaining([expect.stringContaining(`Missing token grant on-chain for ${EXTRA_TOKEN}`)]),
    );
  });

  it("allows verification to be skipped via verify: false option", async () => {
    const { runtime } = stubRuntime();
    const signerReader: AgentSignerReader = {
      getSigner: vi.fn().mockResolvedValue(null), // Would fail if checked
    };
    const agents = build(runtime, undefined, signerReader);

    const result = await agents.mint({
      publicKey: AGENT_PK,
      grants: [{ token: TOKEN, policies: [SPENDING] }],
      verify: false,
    });

    expect(result.hash).toBe("addhash");
    expect(signerReader.getSigner).not.toHaveBeenCalled();
  });
});

describe("wallet.agents.revoke", () => {
  it("removes the agent key and returns the hash", async () => {
    const { runtime, removeAgentKey } = stubRuntime();
    const agents = build(runtime);
    const result = await agents.revoke(AGENT_PK);
    expect(result).toEqual({ hash: "rmhash" });
    expect(removeAgentKey).toHaveBeenCalledWith(AGENT_PK);
  });

  it("rejects a bad public key without calling the runtime", async () => {
    const { runtime, removeAgentKey } = stubRuntime();
    const agents = build(runtime);
    await expect(agents.revoke("nope")).rejects.toBeInstanceOf(InvalidAgentInputError);
    expect(removeAgentKey).not.toHaveBeenCalled();
  });

  it("throws AgentsNotConfiguredError when no runtime is wired", async () => {
    const agents = build(undefined);
    await expect(agents.revoke(AGENT_PK)).rejects.toBeInstanceOf(AgentsNotConfiguredError);
  });
});
