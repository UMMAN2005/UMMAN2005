import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPIENT, NETWORKS, amountToWei, discoverWallets, paymentError, requestDonation } from './donate.js';

const ACCOUNT = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;

function mockWallet(options = {}) {
  let chainId = options.chainId ?? '0x1';
  let added = false;
  const calls = [];
  return {
    calls,
    async request(call) {
      calls.push(call);
      switch (call.method) {
        case 'eth_requestAccounts':
          if (options.connectionError) throw options.connectionError;
          return options.accounts ?? [ACCOUNT];
        case 'eth_accounts': return options.currentAccounts ?? [ACCOUNT];
        case 'eth_chainId': return chainId;
        case 'wallet_switchEthereumChain':
          if (options.switchError) throw options.switchError;
          if (options.unknownChain && !added) throw { code: 4902 };
          if (!options.ignoreSwitch) chainId = call.params[0].chainId;
          return null;
        case 'wallet_addEthereumChain': added = true; return null;
        case 'eth_sendTransaction':
          if (options.sendError) throw options.sendError;
          return options.hash ?? HASH;
        default: throw new Error(`Unexpected method: ${call.method}`);
      }
    },
  };
}

test('amounts preserve all 18 decimal places without rounding', () => {
  assert.equal(amountToWei('0.000000000000000001'), '0x1');
  assert.equal(amountToWei('1.000000000000000001'), `0x${(10n ** 18n + 1n).toString(16)}`);
  assert.equal(amountToWei(' 0.01 '), '0x2386f26fc10000');
});

test('invalid, zero, excessively precise, and overflowing amounts are rejected', () => {
  for (const amount of ['', '0', '0.0', '-1', '1e3', 'NaN', 'Infinity', '1,2', '.1', '01', '0.0000000000000000001', '9'.repeat(100)]) {
    assert.throws(() => amountToWei(amount), undefined, amount);
  }
});

for (const networkId of ['1', '56', '137']) {
  test(`payment on chain ${networkId} uses the selected provider, recipient, and exact value`, async () => {
    const chosen = mockWallet();
    const other = mockWallet();
    const result = await requestDonation(chosen, networkId, '0.01');
    const sent = chosen.calls.filter(call => call.method === 'eth_sendTransaction');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, [{ from: ACCOUNT, to: RECIPIENT, value: '0x2386f26fc10000', chainId: NETWORKS[networkId].chainId }]);
    assert.equal(result.explorerUrl, `${NETWORKS[networkId].explorer}/tx/${HASH}`);
    assert.equal(other.calls.length, 0);
  });
}

test('missing networks are added and switched before any payment', async () => {
  const provider = mockWallet({ unknownChain: true });
  await requestDonation(provider, '137', '1');
  const methods = provider.calls.map(call => call.method);
  assert.ok(methods.indexOf('wallet_addEthereumChain') < methods.indexOf('eth_sendTransaction'));
  const config = provider.calls.find(call => call.method === 'wallet_addEthereumChain').params[0];
  assert.equal(config.chainId, '0x89');
  assert.equal(config.nativeCurrency.symbol, 'POL');
  assert.deepEqual(config.rpcUrls, ['https://polygon.drpc.org']);
});

test('connection and network-switch cancellation never request a transaction', async () => {
  for (const options of [{ connectionError: { code: 4001 } }, { switchError: { code: 4001 } }]) {
    const provider = mockWallet(options);
    await assert.rejects(requestDonation(provider, '56', '1'), error => error.code === 4001);
    assert.ok(!provider.calls.some(call => call.method === 'eth_sendTransaction'));
    assert.ok(!provider.calls.some(call => call.method === 'wallet_addEthereumChain'));
  }
});

test('a wallet that fails to switch networks cannot send on the wrong chain', async () => {
  const provider = mockWallet({ ignoreSwitch: true });
  await assert.rejects(requestDonation(provider, '137', '1'), /Select Polygon PoS/);
  assert.ok(!provider.calls.some(call => call.method === 'eth_sendTransaction'));
});

test('changed or disconnected accounts abort the payment', async () => {
  for (const currentAccounts of [[], [`0x${'c'.repeat(40)}`]]) {
    const provider = mockWallet({ currentAccounts });
    await assert.rejects(requestDonation(provider, '1', '1'), /account changed/);
    assert.ok(!provider.calls.some(call => call.method === 'eth_sendTransaction'));
  }
});

test('validation happens before connecting a wallet', async () => {
  const provider = mockWallet();
  await assert.rejects(requestDonation(provider, '1', '0'), /positive amount/);
  await assert.rejects(requestDonation(provider, '999', '1'), /supported network/);
  await assert.rejects(requestDonation(provider, '__proto__', '1'), /supported network/);
  assert.equal(provider.calls.length, 0);
});

test('empty or malformed accounts cannot send', async () => {
  for (const accounts of [[], ['not-an-address']]) {
    const provider = mockWallet({ accounts });
    await assert.rejects(requestDonation(provider, '1', '1'), /No account/);
    assert.ok(!provider.calls.some(call => call.method === 'eth_sendTransaction'));
  }
});

test('cancelled transactions are not retried automatically', async () => {
  const provider = mockWallet({ sendError: { code: 4001 } });
  await assert.rejects(requestDonation(provider, '1', '1'), error => error.code === 4001);
  assert.equal(provider.calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
});

test('malformed transaction responses tell donors to check wallet activity', async () => {
  await assert.rejects(requestDonation(mockWallet({ hash: 'invalid' }), '1', '1'), /Check its activity before trying again/);
});

test('EIP-6963 discovers Rabby and MetaMask separately and deduplicates announcements', () => {
  const target = new EventTarget();
  const rabby = mockWallet();
  const metamask = mockWallet();
  let wallets = [];
  function announce(provider, name) {
    const event = new Event('eip6963:announceProvider');
    event.detail = { provider, info: { name } };
    target.dispatchEvent(event);
  }
  target.addEventListener('eip6963:requestProvider', () => {
    announce(rabby, 'Rabby Wallet');
    announce(metamask, 'MetaMask');
  });
  target.ethereum = metamask;
  const discovery = discoverWallets(target, entries => { wallets = entries; });
  discovery.refresh();
  assert.equal(wallets.length, 2);
  assert.equal(wallets[0].name, 'Rabby Wallet');
  assert.equal(wallets[0].provider, rabby);
  assert.equal(wallets[1].provider, metamask);
  // Discovery must not connect or prompt either wallet.
  assert.equal(rabby.calls.length + metamask.calls.length, 0);
  discovery.stop();
});

test('legacy provider arrays keep Rabby distinct even when it also claims isMetaMask', () => {
  const target = new EventTarget();
  const rabby = Object.assign(mockWallet(), { isRabby: true, isMetaMask: true });
  const metamask = Object.assign(mockWallet(), { isMetaMask: true });
  target.ethereum = { providers: [rabby, metamask, rabby] };
  let wallets;
  const discovery = discoverWallets(target, entries => { wallets = entries; });
  assert.deepEqual(wallets.map(wallet => wallet.name), ['Rabby', 'MetaMask']);
  discovery.stop();
});

test('late EIP-6963 announcements are accepted and malformed announcements ignored', () => {
  const target = new EventTarget();
  let wallets = [];
  const discovery = discoverWallets(target, entries => { wallets = entries; });
  for (const detail of [null, { provider: {}, info: { name: 'Invalid' } }, { provider: mockWallet(), info: { name: 'Late wallet' } }]) {
    const event = new Event('eip6963:announceProvider');
    event.detail = detail;
    target.dispatchEvent(event);
  }
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].name, 'Late wallet');
  discovery.stop();
});

test('wallet errors provide useful cancellation, pending, and unsupported-method messages', () => {
  assert.match(paymentError({ code: 4001 }), /cancelled/);
  assert.match(paymentError({ code: -32002 }), /already waiting/);
  assert.match(paymentError({ code: 4200 }), /send manually/);
  assert.match(paymentError({ data: { originalError: { code: 4001 } } }), /cancelled/);
});
