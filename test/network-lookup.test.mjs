import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createLookup } from '../src/network.cjs';
const lookup = (fn, host, options = {}) => new Promise((resolve,reject) => {
  fn(host, options, (error, result, family) => error ? reject(error) : resolve({result,family}));
});
test('custom DNS accepts IPv4 and IPv6 literals without DNS requests', async () => {
  const fn = createLookup('cloudflare');
  assert.deepEqual(await lookup(fn,'127.0.0.1'), {result:'127.0.0.1',family:4});
  assert.deepEqual(await lookup(fn,'::1',{all:true}), {result:[{address:'::1',family:6}],family:undefined});
});
test('custom DNS resolves domain hostnames with both address families', async t => {
  t.mock.method(dns.Resolver.prototype,'resolve4',(_host,cb)=>cb(null,['192.0.2.1']));
  t.mock.method(dns.Resolver.prototype,'resolve6',(_host,cb)=>cb(null,['2001:db8::1']));
  const fn = createLookup('google');
  assert.deepEqual((await lookup(fn,'reader.example',{all:true})).result,[{address:'192.0.2.1',family:4},{address:'2001:db8::1',family:6}]);
  assert.deepEqual(await lookup(fn,'reader.example',4),{result:'192.0.2.1',family:4});
});
test('custom DNS propagates lookup failures to the caller', async t => {
  const err = Object.assign(new Error('not found'),{code:'ENOTFOUND'});
  t.mock.method(dns.Resolver.prototype,'resolve4',(_host,cb)=>cb(err));
  t.mock.method(dns.Resolver.prototype,'resolve6',(_host,cb)=>cb(err));
  await assert.rejects(lookup(createLookup('cloudflare'),'missing.example',{all:true}),{code:'ENOTFOUND'});
});
