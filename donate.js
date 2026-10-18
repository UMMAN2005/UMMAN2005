export const RECIPIENT = '0x9872d9cC3d16a4A0aA8f4073363e289aBacfd88e';

export const NETWORKS = Object.freeze({
  '1': { chainId: '0x1', chainName: 'Ethereum', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
  '56': { chainId: '0x38', chainName: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com' },
  '137': { chainId: '0x89', chainName: 'Polygon PoS', symbol: 'POL', rpc: 'https://polygon.drpc.org', explorer: 'https://polygonscan.com' },
});

// Use decimal strings and BigInt so small donations never lose precision.
export function amountToWei(input) {
  const amount = String(input).trim();
  if (amount.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount)) {
    throw new Error('Enter a positive amount with up to 18 decimal places, such as 0.01.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (wei <= 0n || wei >= 2n ** 256n) throw new Error('Enter a positive amount within the supported range.');
  return `0x${wei.toString(16)}`;
}

// Select the actual provider, rather than whichever extension owns window.ethereum.
export function discoverWallets(target, onChange) {
  const wallets = [];
  const add = (provider, name, announced = false) => {
    if (!provider || typeof provider.request !== 'function') return;
    const existing = wallets.find(wallet => wallet.provider === provider);
    if (existing) {
      if (announced) existing.name = name;
    } else {
      wallets.push({ provider, name });
    }
    onChange([...wallets]);
  };
  const announce = event => {
    const detail = event.detail;
    if (!detail || typeof detail.info?.name !== 'string') return;
    add(detail.provider, detail.info.name.slice(0, 80), true);
  };
  const refresh = () => {
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    const legacy = target.ethereum;
    const providers = Array.isArray(legacy?.providers) ? legacy.providers : [legacy];
    for (const provider of providers) {
      if (wallets.some(wallet => wallet.provider === provider)) continue;
      const name = provider?.isRabby ? 'Rabby' : provider?.isMetaMask ? 'MetaMask'
        : provider?.isTrust ? 'Trust Wallet' : provider?.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet';
      add(provider, name);
    }
  };
  target.addEventListener('eip6963:announceProvider', announce);
  refresh();
  return { refresh, stop: () => target.removeEventListener('eip6963:announceProvider', announce) };
}

function errorCode(error) {
  return Number(error?.data?.originalError?.code ?? error?.code);
}

export function paymentError(error) {
  const code = errorCode(error);
  if (code === 4001) return 'Request cancelled in your wallet. You can try again when ready.';
  if (code === -32002) return 'A request is already waiting in your wallet. Open it to continue.';
  if (code === 4200 || code === -32601) return 'This wallet does not support this action. Select the network in your wallet and try again, or send manually using the address below.';
  if (code === 4900 || code === 4901) return 'Your wallet is disconnected. Open it, check the network, and try again.';
  return typeof error?.message === 'string' ? error.message.slice(0, 300) : 'Could not prepare the payment. Try again or use the address below.';
}

export async function requestDonation(provider, networkId, amount, update = () => {}) {
  const network = Object.hasOwn(NETWORKS, networkId) ? NETWORKS[networkId] : null;
  if (!network) throw new Error('Choose a supported network.');
  const value = amountToWei(amount);
  if (!provider || typeof provider.request !== 'function') throw new Error('Choose a wallet first.');

  update('Approve the connection in your wallet.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const from = accounts?.[0];
  if (typeof from !== 'string' || !/^0x[\da-f]{40}$/i.test(from)) throw new Error('No account was shared. Unlock your wallet and try again.');

  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== BigInt(network.chainId)) {
    update(`Approve switching to ${network.chainName} in your wallet.`);
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] });
    } catch (error) {
      if (errorCode(error) !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: network.chainId,
        chainName: network.chainName,
        nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
        rpcUrls: [network.rpc],
        blockExplorerUrls: [network.explorer],
      }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] });
    }
  }

  // Abort if the user changes accounts or the wallet did not switch networks.
  const currentAccounts = await provider.request({ method: 'eth_accounts' });
  if (currentAccounts?.[0]?.toLowerCase() !== from.toLowerCase()) throw new Error('Your wallet account changed. Review your account and try again.');
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== BigInt(network.chainId)) {
    throw new Error(`Select ${network.chainName} in your wallet, then try again. No payment was requested.`);
  }
  update(`Review ${String(amount).trim()} ${network.symbol} to Umman in your wallet. Confirm there to send.`);
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: RECIPIENT, value, chainId: network.chainId }] });
  if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) {
    throw new Error('Your wallet returned no transaction hash. Check its activity before trying again.');
  }
  return { hash, explorerUrl: `${network.explorer}/tx/${hash}` };
}

export function initDonationPage() {
  const form = document.querySelector('#donation-form');
  const fields = document.querySelector('#payment-fields');
  const network = document.querySelector('#network');
  const amount = document.querySelector('#amount');
  const wallet = document.querySelector('#wallet');
  const pay = document.querySelector('#pay');
  const status = document.querySelector('#payment-status');
  const transaction = document.querySelector('#transaction');
  let wallets = [];
  let busy = false;

  const chain = new URL(location.href).searchParams.get('chain');
  if (Object.hasOwn(NETWORKS, chain)) network.value = chain;
  const updateNetwork = () => {
    const config = NETWORKS[network.value];
    document.querySelector('#symbol').textContent = config.symbol;
    document.querySelector('#explorer').href = `${config.explorer}/address/${RECIPIENT}`;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('chain', network.value);
    document.querySelector('#metamask-mobile').href = `https://link.metamask.io/dapp/${url.host}${url.pathname}${url.search}`;
    transaction.hidden = true;
    status.textContent = '';
  };
  network.addEventListener('change', updateNetwork);
  updateNetwork();
  fields.disabled = false;

  const renderWallets = entries => {
    wallets = entries;
    if (busy) return;
    const previous = wallet.value;
    wallet.replaceChildren(new Option(entries.length ? 'Choose your wallet' : 'No wallet detected', ''));
    entries.forEach((entry, index) => wallet.add(new Option(entry.name, String(index))));
    if (previous && entries[Number(previous)]) wallet.value = previous;
    else if (entries.length === 1) wallet.value = '0';
    pay.disabled = !entries.length;
    document.querySelector('#wallet-help').textContent = entries.length
      ? 'Choose the wallet you want to use for this donation.'
      : 'Unlock your browser wallet and refresh, or open this page in your wallet’s browser. You can also send manually below.';
  };
  const discovery = discoverWallets(window, renderWallets);
  renderWallets(wallets);
  document.querySelector('#refresh-wallets').addEventListener('click', discovery.refresh);
  window.addEventListener('ethereum#initialized', discovery.refresh, { once: true });
  // Some older wallets inject after the module has loaded.
  setTimeout(discovery.refresh, 1000);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const selected = wallet.value === '' ? null : wallets[Number(wallet.value)];
    transaction.hidden = true;
    status.dataset.error = 'false';
    busy = true;
    fields.disabled = true;
    pay.textContent = 'Check your wallet…';
    try {
      const result = await requestDonation(selected?.provider, network.value, amount.value, message => { status.textContent = message; });
      status.textContent = 'Transaction submitted. Follow its status in the explorer. Thank you!';
      transaction.href = result.explorerUrl;
      transaction.hidden = false;
    } catch (error) {
      status.textContent = paymentError(error);
      status.dataset.error = 'true';
    } finally {
      busy = false;
      fields.disabled = false;
      pay.textContent = 'Review in wallet';
      renderWallets(wallets);
    }
  });

  const copy = (buttonId, statusId, getText) => {
    const button = document.querySelector(buttonId);
    button.hidden = false;
    button.addEventListener('click', async () => {
      const feedback = document.querySelector(statusId);
      try {
        await navigator.clipboard.writeText(getText());
        feedback.textContent = 'Copied.';
      } catch {
        feedback.textContent = buttonId === '#copy-address'
          ? 'Select the address above and copy it manually.' : 'Copy this page’s URL from your browser’s address bar.';
      }
    });
  };
  copy('#copy-address', '#copy-status', () => RECIPIENT);
  copy('#copy-page', '#page-copy-status', () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('chain', network.value);
    return url.href;
  });
}

if (typeof document !== 'undefined') initDonationPage();
