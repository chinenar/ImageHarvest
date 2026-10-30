'use strict';
const $ = (id) => document.getElementById(id);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function status(message, error = false) {
  $('status').textContent = message;
  $('statusDot').classList.toggle('error', error);
}

async function call(method, args) {
  const result = await window.eiw[method](args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function showWorkspaceView(view) {
  const collector = view === 'collector',
    account = view === 'account',
    harvest = view === 'harvestts';
  $('collectorView').hidden = !collector;
  $('browserAccountView').hidden = !account;
  $('harvestTsView').hidden = !harvest;
  $('collectorNav').classList.toggle('active', collector);
  $('browserAccountNav').classList.toggle('active', account);
  $('harvestTsNav').classList.toggle('active', harvest);
  $('collectorSideGuide').hidden = !collector;
  if (harvest) {
    call('harvestTsDnsActivate').catch(() => {});
    harvestUI.ensureHarvestBrowser().catch((error) => {
      $('harvestStatus').textContent = error.message;
    });
  } else {
    if (harvestUI.harvestBlockMode) harvestUI.cancelHarvestBlockMode(false).catch(() => {});
    window.eiw.harvestTsLayout({ visible: false }).catch(() => {});
    window.eiw.harvestTsDnsDeactivate().catch(() => {});
  }
}

async function action(fn) {
  try {
    await fn();
  } catch (error) {
    status(error.message, true);
  }
}
const harvestUI = createHarvestUI({
  $,
  el,
  call,
  action,
  status,
  showWorkspaceView,
  sendToCollector: (target) => sendHarvestToCollector(target),
});
