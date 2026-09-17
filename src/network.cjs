'use strict';
const dns = require('node:dns');
const { isIP } = require('node:net');

const MODES = new Set(['auto', 'cloudflare', 'google', 'adguard', 'compat']);
function normalizeNetworkMode(value) {
  const mode = String(value || '').toLowerCase();
  return MODES.has(mode) ? mode : 'auto';
}
function dnsServers(mode) {
  mode = normalizeNetworkMode(mode);
  if (mode === 'cloudflare' || mode === 'compat') return ['1.1.1.1', '1.0.0.1'];
  if (mode === 'google') return ['8.8.8.8', '8.8.4.4'];
  if (mode === 'adguard') return ['94.140.14.14', '94.140.15.15'];
  return [];
}
function dohTemplate(mode) {
  mode = normalizeNetworkMode(mode);
  if (mode === 'cloudflare' || mode === 'compat') return 'https://cloudflare-dns.com/dns-query';
  if (mode === 'google') return 'https://dns.google/dns-query';
  if (mode === 'adguard') return 'https://dns.adguard-dns.com/dns-query';
  return '';
}
function electronResolverOptions(mode) {
  mode = normalizeNetworkMode(mode);
  const doh = dohTemplate(mode);
  if (!doh) return { enableBuiltInResolver: true, enableHappyEyeballs: true, secureDnsMode: 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'] };
  return { enableBuiltInResolver: true, enableHappyEyeballs: true, secureDnsMode: 'secure', secureDnsServers: [doh] };
}
function chromeArgs(mode) {
  mode = normalizeNetworkMode(mode);
  const doh = dohTemplate(mode), args = [];
  if (doh) args.push('--dns-over-https-mode=secure', `--dns-over-https-templates=${doh}`);
  if (mode === 'compat') args.push('--disable-http2', '--disable-quic');
  return args;
}
function createLookup(mode) {
  const servers = dnsServers(mode);
  if (!servers.length) return undefined;
  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  const resolve = (hostname, family) => new Promise((resolvePromise, reject) => {
    const fn = family === 6 ? resolver.resolve6.bind(resolver) : resolver.resolve4.bind(resolver);
    fn(hostname, (error, addresses) => error ? reject(error) : resolvePromise((addresses || []).map(address => ({ address, family }))));
  });
  return (hostname, options, callback) => {
    const literalFamily = isIP(hostname);
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    if (literalFamily) {
      if (opts.all) callback(null, [{ address: hostname, family: literalFamily }]);
      else callback(null, hostname, literalFamily);
      return;
    }
    const family = Number(opts.family) || 0;
    const families = family === 4 ? [4] : family === 6 ? [6] : [4, 6];    Promise.allSettled(families.map(value => resolve(hostname, value))).then(results => {
      const addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      if (!addresses.length) {
        const firstError = results.find(result => result.status === 'rejected')?.reason || new Error('DNS lookup failed');
        callback(firstError); return;
      }
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(callback);
  };
}
function isRetryableNetworkError(error) {
  const raw = String(error?.message || error || '');
  return /ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_RESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|Timeout .* exceeded|เปิดเว็บนานเกินกำหนด/i.test(raw);
}
function autoFallbackModes(cachedMode = '') {
  const cached = normalizeNetworkMode(cachedMode);
  if (cached === 'cloudflare') return ['cloudflare', 'google'];
  if (cached === 'google') return ['google', 'cloudflare'];
  return ['cloudflare', 'google'];
}
function isCompatibility(mode) { return normalizeNetworkMode(mode) === 'compat'; }

module.exports = {
  normalizeNetworkMode,
  electronResolverOptions,
  chromeArgs,
  createLookup,
  isCompatibility,
  isRetryableNetworkError,
  autoFallbackModes
};