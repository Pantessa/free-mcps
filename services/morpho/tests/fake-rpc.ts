// A tiny fake viem PublicClient for tests: dispatches readContract calls by
// functionName (handlers get the full call for per-address/per-args
// matching) and getBalance by address. Install with
// setRpcForTests(fakeClient(...)) — the one fake serves every chainId;
// reset with setRpcForTests(null).

export type FakeCall = { address: string; functionName: string; args?: readonly unknown[] };

export interface FakeChainState {
  balances?: Record<string, bigint>; // native ETH per address (lowercased)
  blockNumber?: bigint;
  reads?: Record<string, unknown | ((call: FakeCall) => unknown)>;
}

export function fakeClient(state: FakeChainState) {
  return {
    calls: [] as FakeCall[],
    async getBalance({ address }: { address: string }) {
      return state.balances?.[address.toLowerCase()] ?? 0n;
    },
    async getBlockNumber() {
      return state.blockNumber ?? 1n;
    },
    async readContract(call: FakeCall) {
      this.calls.push(call);
      const handler = state.reads?.[call.functionName];
      if (handler === undefined) throw new Error(`fake-rpc: no read handler for ${call.functionName}`);
      return typeof handler === "function" ? (handler as (c: FakeCall) => unknown)(call) : handler;
    },
  };
}
