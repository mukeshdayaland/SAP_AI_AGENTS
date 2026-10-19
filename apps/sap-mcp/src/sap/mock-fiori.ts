/**
 * A stand-in for the Fiori launchpad in mock mode, so the Fiori pane and the
 * agent's steps in it can be developed and tested without an SAP system. One
 * page that takes the intent from the address like the launchpad does, shows a
 * document with a field left empty, and answers Save with a message. It keeps
 * nothing: a reload starts over.
 */
export const MOCK_FIORI_PATH = '/sap/bc/ui2/flp';

export const MOCK_FIORI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fiori (mock)</title>
<style>
  body { margin: 0; font: 14px/1.4 "72", Arial, sans-serif; color: #1d2d3e; background: #f5f6f7; }
  header { background: #fff; border-bottom: 1px solid #d9d9d9; padding: 10px 16px; display: flex; gap: 12px; align-items: baseline; }
  header b { font-size: 16px; }
  header span { color: #556b82; font-size: 12px; }
  main { padding: 16px; max-width: 760px; }
  [role=tablist] { display: flex; gap: 4px; margin-bottom: 12px; }
  [role=tab] { border: 0; background: none; padding: 8px 12px; font: inherit; color: #556b82; cursor: pointer; border-bottom: 2px solid transparent; }
  [role=tab][aria-selected=true] { color: #0064d9; border-color: #0064d9; }
  form { background: #fff; border: 1px solid #d9d9d9; border-radius: 12px; padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
  label { display: block; font-size: 12px; color: #556b82; margin-bottom: 4px; }
  input, select { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid #89919a; border-radius: 4px; padding: 0 8px; font: inherit; background: #fff; }
  input:read-only { background: #f5f6f7; border-color: #d9d9d9; }
  footer { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
  button.action { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid #0064d9; background: #fff; color: #0064d9; font: inherit; cursor: pointer; }
  button.emphasized { background: #0070f2; color: #fff; }
  #message { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; }
  #message:empty { display: none; }
  #message.error { background: #ffeaf4; color: #aa0808; }
  #message.success { background: #f5fae5; color: #256f3a; }
</style>
</head>
<body>
<header><b id="app"></b><span>Mock SAP system. Nothing is saved.</span></header>
<main>
  <div id="message" role="alert"></div>
  <div role="tablist">
    <button role="tab" id="tab-header" aria-selected="true">Header</button>
    <button role="tab" id="tab-items" aria-selected="false">Items</button>
  </div>
  <form id="doc" onsubmit="return false">
    <div><label for="number" id="number-label">Document</label><input id="number" readonly></div>
    <div><label for="partner">Business partner</label><input id="partner" readonly value="7000000010"></div>
    <div><label for="reference">Customer reference</label><input id="reference" value="PO-88231"></div>
    <div><label for="terms">Payment terms</label><input id="terms" placeholder="e.g. 0001"></div>
    <div><label for="block">Delivery block</label><select id="block"><option value="">None</option><option value="01" selected>01 Credit limit</option><option value="02">02 Political reasons</option></select></div>
    <div><label for="incoterms">Incoterms</label><input id="incoterms" value="CIF Jeddah"></div>
  </form>
  <footer>
    <button class="action" id="check">Check</button>
    <button class="action emphasized" id="save">Save</button>
  </footer>
</main>
<script>
  var intent = (location.hash.slice(1).split('?')[0] || 'Shell-home');
  var params = new URLSearchParams(location.hash.split('?')[1] || '');
  var number = params.values().next().value || '';
  var object = intent.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  document.getElementById('app').textContent = intent.split('-')[1] + ' ' + object + (number ? ' ' + number : '');
  document.title = document.getElementById('app').textContent;
  document.getElementById('number-label').textContent = object.charAt(0).toUpperCase() + object.slice(1);
  document.getElementById('number').value = number;
  var message = document.getElementById('message');
  function say(kind, text) { message.className = kind; message.textContent = text; }
  function incomplete() { return document.getElementById('terms').value.trim() ? '' : 'Payment terms are missing. The document is incomplete.'; }
  document.getElementById('check').onclick = function () { var e = incomplete(); say(e ? 'error' : 'success', e || 'No errors found.'); };
  document.getElementById('save').onclick = function () { var e = incomplete(); say(e ? 'error' : 'success', e || (document.getElementById('app').textContent + ' was saved (mock).')); };
  Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (tab) {
    tab.onclick = function () { Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (t) { t.setAttribute('aria-selected', String(t === tab)); }); };
  });
</script>
</body>
</html>
`;
