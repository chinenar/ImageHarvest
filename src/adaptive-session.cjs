// Bounded strategy planner. Only predefined collector options can be selected.
'use strict';
const { scopeFor, fingerprint, classifyChange, verification } = require('./adaptive-core.cjs');
const DEFAULT_ATTRS = new Set(['data-src', 'data-original', 'data-lazy-src', 'data-url']);
class AdaptiveSession {
  constructor({ store, url, mode, probe, observation, notify = () => {} }) {
    this.store = store; this.scope = scopeFor(url, mode); this.readProbe = probe;
    this.observation = observation; this.notify = notify; this.probe = {};
    this.attempts = [{ strategy: 'dom', verified: 0 }]; this.verifiedIds = new Set();
    this.started = Date.now(); this.strategySource = 'default'; this.probeUnavailable = false;
  }
  async observe() {
    let timer;
    try {
      const value = await Promise.race([this.readProbe(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe-timeout')), 2500);
      })]);
      if (value && typeof value === 'object') this.probe = value;
    } catch { this.probeUnavailable = true; }
    finally { clearTimeout(timer); }
    this.snapshot = fingerprint(this.probe, this.observation(this.probe.scriptSources || []));
    this.change = classifyChange(this.store.baseline(this.scope), this.snapshot);
  }
  available(options) {
    const choices = [];
    if ((this.probe.lazyAttributes || []).some(x => !DEFAULT_ATTRS.has(x)) && !options.lazyAttributes?.length) choices.push('lazy-attributes');
    if (this.probe.backgrounds > 0 && !options.backgrounds) choices.push('css-backgrounds');
    if (options.autoScroll && !options.conservativeScroll) choices.push('conservative-scroll');
    return choices;
  }
  apply(strategy, options) {
    if (this.attempts.some(x => x.strategy === strategy) || this.attempts.length >= 4) return false;
    if (strategy === 'lazy-attributes') options.lazyAttributes = (this.probe.lazyAttributes || []).filter(x => /^data-[a-z][a-z0-9-]{0,50}$/.test(x)).slice(0, 16);
    else if (strategy === 'css-backgrounds') { options.backgrounds = true; options.adaptiveBackgrounds = true; }
    else if (strategy === 'conservative-scroll') options.conservativeScroll = true;
    else return false;
    this.attempts.push({ strategy, verified: 0 });
    this.notify('status', { message: `Adaptive • ลองวิธี ${strategy}` });
    return true;
  }
  async start(options) {
    await this.observe();
    const available = this.available(options);
    const suggestion = this.store.suggest(this.scope, this.probe.family, available);
    if (suggestion && this.apply(suggestion.strategy, options)) { this.strategySource = suggestion.source; return; }
    // Safe page-local evidence can be used immediately on a first visit; history is not required.
    // Scrolling remains conservative-by-recovery because slowing every new site would be expensive.
    const observed = available.find(x => x === 'lazy-attributes' || x === 'css-backgrounds');
    if (observed && this.apply(observed, options)) this.strategySource = 'page-observation';
  }
  update(items) {
    const eligible = items.filter(x => x.capturePath || (x.source === 'img' && x.decoded));
    const v = verification(eligible);
    const ids = eligible.filter(x => !x.filterHints?.chrome && x.width >= 240 && x.height >= 240).map(x => x.id);
    if (v.verified) for (const id of ids) if (!this.verifiedIds.has(id)) {
      this.verifiedIds.add(id); this.attempts[this.attempts.length - 1].verified++;
    }
  }
  observedCandidateCount() {
    const p = this.probe || {};
    if (p.family === 'img') return Number(p.images) || 0;
    if (p.family === 'canvas') return Number(p.canvases) || 0;
    if (p.family === 'background') return Number(p.backgrounds) || 0;
    if (p.family === 'mixed') return (Number(p.images) || 0) + (Number(p.canvases) || 0) + (Number(p.backgrounds) || 0);
    return 0;
  }
  async recover(options, items, scrollStalled = false) {
    if (this.attempts.length >= 4) return false;
    const v = verification(items);
    await this.observe();
    const floor = Math.max(Number(this.probe.expectedTotal) || 0, this.observedCandidateCount());
    const short = floor > v.candidates || v.verified < v.candidates;
    if (!scrollStalled && !short && v.verified > 0) return false;
    const choices = this.available(options);
    const strategy = scrollStalled ? choices.find(x => x === 'conservative-scroll') : choices.find(x => x !== 'conservative-scroll');
    return strategy ? this.apply(strategy, options) : false;
  }
  async finish({ items = [], cancelled = false, truncated = false, failures = 0, error = false, stopReason = '' } = {}) {
    this.update(items); await this.observe();
    const v = verification(items), network = this.observation([]);
    const gated = [401, 403, 429].includes(network.documentStatus);
    const observedFloor = Math.max(Number(this.probe.expectedTotal) || 0, this.observedCandidateCount());
    const countShort = observedFloor > v.candidates;
    const eligible = !cancelled && !truncated && !failures && !error && !gated && !countShort;
    const outcome = cancelled ? 'cancelled' : gated ? 'blocked' : error ? 'error' : failures || truncated || countShort ? 'partial' :
      v.candidates === 0 ? 'empty' : v.verified === v.candidates ? 'usable' : 'partial';
    const result = { enabled: true, version: 1, change: this.change, family: this.snapshot.family,
      outcome, ...v, completeness: 'unverified', observedFloor: observedFloor || null, countShort,
      declaredTotal: Number(this.probe.expectedTotal) || null,
      declaredTotalMatched: this.probe.expectedTotal > 0 && v.verified === this.probe.expectedTotal && v.candidates === v.verified,
      attempts: this.attempts.map(x => ({ ...x })), strategySource: this.strategySource,
      stopReason, eligibleForLearning: eligible && v.candidates > 0, probeUnavailable: this.probeUnavailable,
      profileWarning: this.store.warning, mode: this.scope.mode, snapshot: this.snapshot,
      network: { scriptCount: network.scriptCount, hashedScripts: network.hashedScripts, images: network.images, imageErrors: network.imageErrors, documentStatus: network.documentStatus } };
    await this.store.remember(this.scope, this.snapshot, result);
    result.profileWarning = this.store.warning;
    return result;
  }
}
function describeAdaptive(result) {
  if (!result) return '';
  const change = { 'first-seen': 'พบรูปแบบใหม่', 'reader-change': 'โครงสร้างการอ่านเปลี่ยน', 'build-change': 'ไฟล์เว็บเปลี่ยน', stable: 'รูปแบบเดิม', 'observation-unavailable': 'ข้อมูลเปรียบเทียบไม่พอ' }[result.change];
  return `Adaptive: ${change || result.change} • ${result.attempts.map(x => x.strategy).join(' → ')} • ตรวจภาพใช้ได้ ${result.verified}/${result.candidates} (ยังไม่ยืนยันจำนวนหน้าทั้งตอน)${result.profileWarning ? ' • บันทึกการเรียนรู้ไม่ได้' : ''}`;
}
module.exports = { AdaptiveSession, describeAdaptive };
