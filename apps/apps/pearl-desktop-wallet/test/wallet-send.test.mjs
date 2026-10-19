import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadSource(mocks) {
  const modules = new Map();
  const load = filename => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = {exports: {}};
    modules.set(filename, module);
    const {outputText} = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
    });
    const require = request => {
      if (Object.hasOwn(mocks, request)) return mocks[request];
      if (request.startsWith('.')) return load(resolve(dirname(filename), `${request}.ts`));
      return createRequire(filename)(request);
    };
    new Function('require', 'module', 'exports', outputText)(require, module, module.exports);
    return module.exports;
  };
  return path => load(resolve(appDir, path));
}

function walletBridge(reply, manager = {}) {
  const handlers = new Map();
  const requests = [];
  let multisigState = {vaults: [], pendingTxs: [], sentTxs: []};
  let bridge;
  const load = loadSource({
    axios: {
      post: async (_url, request) => {
        requests.push(request);
        if (reply instanceof Error) throw reply;
        return {data: reply};
      },
      isAxiosError: () => false,
    },
    electron: {
      ipcMain: {handle: (channel, handler) => handlers.set(channel, handler)},
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          try {
            return structuredClone(await handlers.get(channel)({}, ...structuredClone(args)));
          } catch (error) {
            // Electron drops custom properties on errors thrown by an IPC handler.
            throw new Error(error.message);
          }
        },
      },
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          bridge = value;
        },
      },
    },
    '../clients/blockbook-client': {BlockbookClient: {}},
    '../services/multisig-store': {
      loadMultisigState: () => multisigState,
      saveMultisigState: state => {
        multisigState = state;
      },
    },
  });
  const {RpcClient} = load('src/main/services/rpc-client.ts');
  const {WalletRpcMethods} = load('src/main/services/wallet-service/wallet-rpc-methods.ts');
  const {registerWalletIpc} = load('src/main/ipc/register-wallet-ipc.ts');
  const rpc = new RpcClient({rpcHost: 'http://127.0.0.1', rpcPort: 0, rpcUser: 'test', rpcPassword: 'test'});
  registerWalletIpc({ensureWalletService: () => new WalletRpcMethods(rpc), ...manager});
  load('src/preload/index.ts');
  const {getSendFailure} = load('src/renderer/src/lib/send-result.ts');
  return {bridge, requests, getSendFailure};
}

test('fresh-send retry requires numeric RPC code -9 across the RPC, IPC and preload path', async t => {
  const safeMessage =
    'No peers are connected. Nothing was signed or sent and your funds are untouched. ' +
    'Check your connection and try again.';
  const cases = [
    {name: 'preflight with unrelated wording', error: {code: -9, message: 'offline'}, canRetry: true},
    {name: 'peer text lookalike', error: {code: -32603, message: 'peer says not relayed'}, canRetry: false},
    {name: 'exact warning lookalike', error: {code: -32603, message: safeMessage}, canRetry: false},
    {name: 'message-only old daemon', error: {message: 'not relayed'}, canRetry: false},
    {name: 'code in message', error: {code: -32603, message: '{"code":-9}: not relayed'}, canRetry: false},
    {name: 'string code', error: {code: '-9', message: 'not relayed'}, canRetry: false},
    {name: 'transport failure', transport: new Error('not relayed'), canRetry: false},
    {name: 'non-RPC error code', transport: Object.assign(new Error('not relayed'), {code: -9}), canRetry: false},
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const {bridge, getSendFailure} = walletBridge(scenario.transport ?? {error: scenario.error});
      const result = structuredClone(await bridge.wallet.sendFromDefaultAccount('recipient', 1, 0.00001));
      assert.equal(result.ok, false);
      const failure = getSendFailure(result.error);
      assert.equal(failure.canRetry, scenario.canRetry);
      assert.equal(failure.message, scenario.canRetry ? safeMessage : (scenario.error ?? scenario.transport).message);
      assert.equal(result.error.code === -9, scenario.canRetry);
    });
  }
});

test('successful sends preserve the txid and send arguments through IPC and preload', async () => {
  const txid = 'ab'.repeat(32);
  const {bridge, requests} = walletBridge({result: txid, error: null});
  assert.deepEqual(await bridge.wallet.sendFromDefaultAccount('recipient', 1, 0.00001), {ok: true, txid});
  assert.equal(requests[0].method, 'sendmany');
  assert.deepEqual(requests[0].params, ['default', {recipient: 1}, 0.00001, 0]);
});

test('rebroadcast failure stays generic even when its message contains not relayed', async () => {
  const {bridge} = walletBridge({error: {code: -32603, message: 'not relayed'}});
  await assert.rejects(bridge.wallet.rebroadcastTransaction('ab'.repeat(32)), error => {
    assert.equal(error.message, 'not relayed');
    assert.equal(error.code, undefined);
    return true;
  });
});

test('multisig key derivation preserves the key and RPC arguments through the v3 bridge', async () => {
  const key = {pubkeyHex: 'ab'.repeat(32), privKeyHex: 'cd'.repeat(32), originPath: "m/86'/808276'/100'/2'/7"};
  const {bridge, requests} = walletBridge({result: key, error: null});
  assert.deepEqual(await bridge.wallet.deriveMultisigKey(2, 7), key);
  assert.equal(requests[0].method, 'derivemultisigkey');
  assert.deepEqual(requests[0].params, [2, 7]);
});

test('multisig unlock waits for the daemon before unlocking the seed and retains lock handlers', async () => {
  const calls = [];
  let requests;
  const result = walletBridge(
    {result: null, error: null},
    {
      unlockCurrentWalletSeed: async passphrase => {
        assert.equal(requests[0].method, 'walletpassphrase');
        assert.deepEqual(requests[0].params, ['test-password', 120]);
        calls.push(['seed', passphrase]);
        return {seed: 'test-seed'};
      },
      lockWallet: async () => {
        calls.push(['lock']);
      },
      forceLockWallet: async () => {
        calls.push(['force-lock']);
      },
      rotateCurrentWalletSeedPassword: async (...args) => {
        calls.push(['rotate', ...args]);
      },
    }
  );
  requests = result.requests;
  const {wallet} = result.bridge;
  assert.deepEqual(await wallet.unlockWallet('test-password', 120), {seed: 'test-seed'});
  await wallet.lockWallet();
  await wallet.forceLockWallet();
  await wallet.changeWalletPassphrase('old-password', 'new-password');
  assert.equal(requests[1].method, 'walletpassphrasechange');
  assert.deepEqual(requests[1].params, ['old-password', 'new-password']);
  assert.deepEqual(calls, [
    ['seed', 'test-password'],
    ['lock'],
    ['force-lock'],
    ['rotate', 'old-password', 'new-password'],
  ]);
});

test('a failed daemon unlock never exposes the multisig seed', async () => {
  let seedUnlocked = false;
  const {bridge} = walletBridge(
    {error: {code: -14, message: 'incorrect passphrase'}},
    {
      unlockCurrentWalletSeed: async () => {
        seedUnlocked = true;
      },
    }
  );
  await assert.rejects(bridge.wallet.unlockWallet('wrong-password'), /incorrect passphrase/);
  assert.equal(seedUnlocked, false);
});

test('vaults and pending and sent proposals round-trip through the v3 bridge', async () => {
  const {bridge} = walletBridge({result: null, error: null});
  const state = {
    vaults: [{id: 'vault-1', threshold: 2, total: 3}],
    pendingTxs: [{id: 'proposal-1', psbtBase64: 'test-psbt'}],
    sentTxs: [{txid: 'ab'.repeat(32)}],
  };
  await bridge.wallet.saveMultisigState(state);
  const loaded = await bridge.wallet.getMultisigState();
  assert.deepEqual(loaded, state);
  loaded.vaults[0].threshold = 1;
  assert.deepEqual(await bridge.wallet.getMultisigState(), state);
});
